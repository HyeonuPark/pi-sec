// @vitest-environment jsdom
/**
 * Notes: the daemon's five most recent diagnostics.
 *
 * These are the assertions `test/web-ui.test.ts` made on `renderNotes` (the
 * recent ones, newest first, with an age; the panel hiding itself when there is
 * nothing to say) moved onto the new component, plus the seam the header branch
 * uses to hand the same status answer in.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { mountSideParts, startSidePanels } from "../../src/ui/chat/SideParts.tsx";
import { resetInboxState } from "../../src/ui/state/inbox.ts";
import { resetJobsState } from "../../src/ui/state/jobs.ts";
import { applyStatus, NOTES_LIMIT, notes, refreshNotes, resetNotesState } from "../../src/ui/state/notes.ts";
import { resetQueriesState } from "../../src/ui/state/queries.ts";

interface Call {
  readonly url: string;
  readonly method: string;
}

type Answer = { readonly status?: number; readonly body?: unknown };

const routes = new Map<string, (call: Call) => Answer>();
let calls: Call[] = [];

async function installShell(): Promise<void> {
  const html = await readFile(join(process.cwd(), "src/web/index.html"), "utf8");
  const stripped = html.replaceAll("{{base}}", "").replace(/<script\b[^>]*>\s*<\/script>/gi, "");
  const parsed = new DOMParser().parseFromString(stripped, "text/html");
  document.body.innerHTML = parsed.body.innerHTML;
  for (const attribute of parsed.body.attributes) document.body.setAttribute(attribute.name, attribute.value);
  document.head.innerHTML = parsed.head.innerHTML;
}

function response(status: number, body: unknown): Response {
  const text = body === undefined ? "" : JSON.stringify(body);
  return { ok: status >= 200 && status < 300, status, statusText: String(status), text: async () => text } as Response;
}

function answer(path: string, route: (call: Call) => Answer): void {
  routes.set(path, route);
}

function defaults(): void {
  answer("/api/jobs", () => ({ body: { tree: [] } }));
  answer("/api/preferences", () => ({ body: { hiddenJobs: [], expandedJobs: [], clearedInbox: [] } }));
  answer("/api/inbox", () => ({ body: { items: [] } }));
  answer("/api/user-queries", () => ({ body: { queries: [] } }));
  answer("/api/admin/status", () => ({ body: { notes: [] } }));
}

const panel = () => document.querySelector<HTMLElement>("#notes-panel")!;
const body = () => document.querySelector<HTMLElement>("#notes")!;
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(async () => {
  routes.clear();
  calls = [];
  (globalThis as unknown as { fetch: unknown }).fetch = async (input: unknown, init?: { method?: string }) => {
    const url = String(input);
    const parsed = new URL(url, "http://localhost");
    const call: Call = { url: parsed.pathname + parsed.search, method: (init?.method ?? "GET").toUpperCase() };
    calls.push(call);
    const route = routes.get(call.url) ?? routes.get(parsed.pathname);
    const answered = route === undefined ? { status: 200, body: {} } : route(call);
    return response(answered.status ?? 200, answered.body);
  };
  await installShell();
  defaults();
  resetJobsState();
  resetInboxState();
  resetQueriesState();
  resetNotesState();
  mountSideParts();
});

describe("the notes panel", () => {
  it("shows five of the recent ones, newest first, with an age", async () => {
    const now = Date.now();
    // The server writes a note when it happens, so the list is oldest first.
    const list = Array.from({ length: 7 }, (_, index) => ({
      at: now - (6 - index) * 60_000,
      text: `note ${index}`,
    }));
    answer("/api/admin/status", () => ({ body: { notes: list } }));
    await startSidePanels();
    await settle();

    expect(panel().className).toBe("panel");
    const notes = [...body().querySelectorAll<HTMLElement>(".note")];
    expect(notes).toHaveLength(NOTES_LIMIT);
    // The server writes oldest first; the panel reads the newest five, newest first.
    expect(notes[0]!.querySelector(".note-body")!.textContent).toBe("note 6");
    expect(notes.at(-1)!.querySelector(".note-body")!.textContent).toBe("note 2");
    expect(notes[0]!.querySelector(".note-meta")!.textContent).toBe("just now");
    expect(notes[1]!.querySelector(".note-meta")!.textContent).toBe("1m ago");
    expect(notes[2]!.querySelector(".note-meta")!.textContent).toBe("2m ago");
    expect(panel().querySelector("h2")!.textContent).toBe("Notes");
    expect(panel().querySelector("#notes")).toBe(body());
  });

  it("hides the panel when the daemon has nothing to say", async () => {
    await startSidePanels();
    await settle();

    expect(panel().className).toBe("panel hidden");
    expect(body().querySelectorAll(".note")).toHaveLength(0);
  });

  it("takes the notes out of a status answer handed in by another reader", async () => {
    mountSideParts();
    const now = Date.now();
    applyStatus({ notes: [{ at: now, text: "mount conflict: X-Forwarded-Prefix \"/other\"" }], restartRequired: true });
    await settle();

    expect(notes.value).toHaveLength(1);
    expect(panel().className).toBe("panel");
    expect(body().textContent).toContain("/other");
    // A broken answer is not drawn: an entry without a text is dropped.
    applyStatus({ notes: [{ at: now }, "nonsense"] });
    await settle();
    expect(notes.value).toHaveLength(0);
    expect(panel().className).toBe("panel hidden");
  });

  it("keeps the last notes when the status read fails", async () => {
    answer("/api/admin/status", () => ({ status: 500, body: { error: { code: "failed", message: "no" } } }));
    applyStatus({ notes: [{ at: Date.now(), text: "config reload failed: server.basePath is a URL" }] });
    await refreshNotes();
    await settle();

    expect(body().textContent).toContain("config reload failed");
  });
});
