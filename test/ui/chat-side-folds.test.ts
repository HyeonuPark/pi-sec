// @vitest-environment jsdom
/**
 * Folding the inbox, the job tree and the machines from their headings.
 *
 * The three headings are buttons, and a press saves the choice on the server (one
 * list for wide screens, one for narrow screens), keeps it in the browser as a
 * cache (`pi-sec-folded-panels`) and writes the folded names on
 * `<body data-folded>`, which is what the stylesheet hides a list by. Three things
 * about that are worth a test without a browser:
 *
 *   - the press, the attribute and the stored value move together, and a second
 *     press puts all three back;
 *   - a page that is mounted with a stored value starts folded, and a value this
 *     page cannot use (a broken one, an unknown name, or no store at all) is
 *     dropped whole so every panel is drawn open;
 *   - the heading keeps saying what the fold would hide: the unread count of the
 *     inbox, the number of jobs with an agent on them, and a stopped machine.
 *
 * The shell is the real `src/web/index.html`, parsed into this document the way
 * `test/ui/chat-side-machines.test.ts` does it, so the headings are the ones the
 * page carries.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mountSideParts, startSidePanels } from "../../src/ui/chat/SideParts.tsx";
import { FOLDS_KEY } from "../../src/ui/state/folds.ts";
import { fakePreferences, type FakePreferences } from "./preferences-fake.ts";
import { applyJobEvent, JOBS_REFRESH_WINDOW_MS, resetJobsState } from "../../src/ui/state/jobs.ts";
import { applyInboxFrame, resetInboxState } from "../../src/ui/state/inbox.ts";
import { resetMachinesState } from "../../src/ui/state/machines.ts";
import { resetNotesState } from "../../src/ui/state/notes.ts";
import { resetQueriesState } from "../../src/ui/state/queries.ts";

/* ------------------------------------------------------------ the page */

interface Call {
  readonly url: string;
  readonly method: string;
  readonly body: string | null;
}

type Answer = { readonly status?: number; readonly body?: unknown } | Promise<{ readonly status?: number; readonly body?: unknown }>;
type Route = (call: Call) => Answer;

const routes = new Map<string, Route>();
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
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: String(status),
    text: async () => text,
  } as Response;
}

function answer(path: string, route: Route): void {
  routes.set(path, route);
}

/** The server's shared state for this test. */
let server: FakePreferences = fakePreferences();

/** The routes every panel reads, before a test changes one. */
function defaults(): void {
  server = fakePreferences();
  answer("/api/jobs", () => ({ body: { tree: [] } }));
  answer("/api/preferences", (call) => server.handle(call));
  answer("/api/inbox", () => ({ body: { items: [] } }));
  answer("/api/user-queries", () => ({ body: { queries: [] } }));
  answer("/api/admin/status", () => ({ body: {} }));
  answer("/api/remote-machines", () => ({ body: { enabled: true, machines: [] } }));
}

/** One notice, as `GET /api/inbox` answers with it. */
function note(id: string, over: Record<string, unknown> = {}) {
  return { id, kind: "notice", title: "Brief ready", body: "All good", createdAt: Date.now() - 60_000, ...over };
}

/** One machine, as `GET /api/remote-machines` answers with it. */
function machine(over: Record<string, unknown> = {}) {
  return {
    id: "box-a",
    address: "192.0.2.10",
    port: 22,
    users: [{ name: "alice", state: "reachable", since: 1_793_430_000_000, error: null }],
    level: "restricted",
    levelChangedAt: 1_793_430_000_000,
    pending: null,
    hostKey: "pinned",
    blocked: null,
    ...over,
  };
}

/** One node of the job tree, as `GET /api/jobs?shape=tree` answers with it. */
function node(id: string, over: Record<string, unknown> = {}, children: unknown[] = []) {
  return {
    job: { id, title: id, status: "active", labels: [], stats: { runs: 0, failures: 0 }, working: [], ...over },
    children,
  };
}

function setTree(tree: unknown[]): void {
  answer("/api/jobs?shape=tree", () => ({ body: { tree } }));
}

function setInbox(items: unknown[]): void {
  answer("/api/inbox", () => ({ body: { items } }));
}

function setMachines(machines: unknown[], enabled = true): void {
  answer("/api/remote-machines", () => ({ body: { enabled, machines } }));
}

/** A stored choice, as an earlier page load wrote it. */
function storeFolds(names: string[]): void {
  window.localStorage.setItem(FOLDS_KEY, JSON.stringify(names));
}

/** What the page stored, in the sidebar's own order. */
function storedFolds(): string[] {
  const raw = window.localStorage.getItem(FOLDS_KEY);
  return raw === null ? [] : (JSON.parse(raw) as string[]);
}

/** The folded names the stylesheet reads off the body. */
function bodyFolds(): string[] {
  const value = document.body.dataset.folded ?? "";
  return value === "" ? [] : value.split(" ");
}

const foldButton = (panel: string) =>
  document.querySelector<HTMLButtonElement>(`#${panel}-fold`)!;
const panel = (panel: string) => document.querySelector<HTMLElement>(`section[data-panel="${panel}"]`)!;
const badge = () => document.querySelector<HTMLElement>("#inbox-count")!;
const workingBadge = () => document.querySelector<HTMLElement>("#jobs-working")!;
const stoppedBadge = () => document.querySelector<HTMLElement>("#machines-stopped")!;
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/** Press a heading button and let the page redraw what the press changed. */
async function press(panel: string): Promise<void> {
  foldButton(panel).click();
  await settle();
}

/** Put the shell in the document and mount the sidebar's parts on it. */
async function mount(): Promise<void> {
  await installShell();
  Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
  defaults();
  resetJobsState();
  resetInboxState();
  resetQueriesState();
  resetNotesState();
  resetMachinesState();
  mountSideParts();
}

beforeEach(async () => {
  routes.clear();
  calls = [];
  window.localStorage.clear();
  (globalThis as unknown as { fetch: unknown }).fetch = async (input: unknown, init?: { method?: string; body?: string }) => {
    const url = String(input);
    const parsed = new URL(url, "http://localhost");
    const call: Call = {
      url: parsed.pathname + parsed.search,
      method: (init?.method ?? "GET").toUpperCase(),
      body: init?.body ?? null,
    };
    calls.push(call);
    const route = routes.get(call.url) ?? routes.get(parsed.pathname);
    const answered = route === undefined ? { status: 200, body: {} } : await route(call);
    return response(answered.status ?? 200, answered.body);
  };
  await mount();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("folding a panel from its heading", () => {
  it("gives every foldable panel a heading button that names the list it folds", () => {
    for (const name of ["inbox", "jobs", "machines"]) {
      const button = foldButton(name);
      expect(button.tagName).toBe("BUTTON");
      expect(button.getAttribute("type")).toBe("button");
      expect(button.getAttribute("aria-expanded")).toBe("true");
      expect(button.getAttribute("aria-controls")).toBe(name);
      // The heading's own text is the panel's name: the caret is drawn, so it
      // adds no character to what the heading says.
      expect(button.textContent).toBe(name === "inbox" ? "Inbox" : name === "jobs" ? "Jobs" : "Machines");
      expect(button.querySelector(".panel-fold-caret svg")).not.toBeNull();
      expect(button.querySelector(".panel-fold-caret")!.getAttribute("aria-hidden")).toBe("true");
      // The panel the button folds is the one the stylesheet is told about.
      expect(panel(name).contains(button)).toBe(true);
    }
    // Nothing is folded on a first visit, and nothing is stored yet.
    expect(bodyFolds()).toEqual([]);
    expect(window.localStorage.getItem(FOLDS_KEY)).toBeNull();
  });

  it("folds all three, marks them, and stores them, then puts them back", async () => {
    for (const name of ["inbox", "jobs", "machines"]) await press(name);

    for (const name of ["inbox", "jobs", "machines"]) {
      expect(foldButton(name).getAttribute("aria-expanded")).toBe("false");
      // The caret turned: the folded panel draws the triangle that points in.
      expect(foldButton(name).querySelector(".panel-fold-caret svg path")!.getAttribute("d")).toContain("M4.5 2.5");
    }
    // The sheets read one attribute, and it holds the same order the sidebar draws.
    expect(bodyFolds()).toEqual(["inbox", "jobs", "machines"]);
    expect(storedFolds()).toEqual(["inbox", "jobs", "machines"]);

    for (const name of ["inbox", "jobs", "machines"]) await press(name);

    for (const name of ["inbox", "jobs", "machines"]) {
      expect(foldButton(name).getAttribute("aria-expanded")).toBe("true");
      expect(foldButton(name).querySelector(".panel-fold-caret svg path")!.getAttribute("d")).toContain("M2.5 4.5");
    }
    expect(bodyFolds()).toEqual([]);
    expect(storedFolds()).toEqual([]);
  });

  it("folds one panel without touching the others", async () => {
    await press("jobs");

    expect(foldButton("jobs").getAttribute("aria-expanded")).toBe("false");
    expect(foldButton("inbox").getAttribute("aria-expanded")).toBe("true");
    expect(foldButton("machines").getAttribute("aria-expanded")).toBe("true");
    expect(bodyFolds()).toEqual(["jobs"]);
    expect(storedFolds()).toEqual(["jobs"]);
  });

  it("starts folded when the browser remembers a folded panel", async () => {
    storeFolds(["inbox", "machines"]);

    await mount();

    expect(foldButton("inbox").getAttribute("aria-expanded")).toBe("false");
    expect(foldButton("machines").getAttribute("aria-expanded")).toBe("false");
    expect(foldButton("jobs").getAttribute("aria-expanded")).toBe("true");
    expect(bodyFolds()).toEqual(["inbox", "machines"]);
  });

  it("draws every panel open when the stored value cannot be used", async () => {
    for (const broken of ["{not json", "[]", '"inbox"', '["inbox","notes"]', '["awaiting"]', "null", "7"]) {
      window.localStorage.setItem(FOLDS_KEY, broken);
      await mount();
      for (const name of ["inbox", "jobs", "machines"]) {
        expect(foldButton(name).getAttribute("aria-expanded"), `${broken} folded ${name}`).toBe("true");
      }
      expect(bodyFolds(), `${broken} reached the body`).toEqual([]);
    }
  });

  it("folds and unfolds without a store, and says so on screen only", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("SecurityError: the store is withheld");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError: the store is full");
    });

    await mount();
    await press("inbox");

    expect(foldButton("inbox").getAttribute("aria-expanded")).toBe("false");
    expect(bodyFolds()).toEqual(["inbox"]);
  });
});

describe("what a folded heading still says", () => {
  it("raises the unread count of a folded inbox as notices arrive", async () => {
    setInbox([note("i1")]);
    await startSidePanels();
    await settle();
    await press("inbox");
    expect(badge().textContent).toBe("1");
    expect(badge().className).toContain("badge");
    expect(badge().closest("h2")).not.toBeNull();

    setInbox([note("i1"), note("i2")]);
    applyInboxFrame("report_created");
    await settle();

    expect(badge().textContent).toBe("2");
    // The fold held through the read, and the list really was read again.
    expect(foldButton("inbox").getAttribute("aria-expanded")).toBe("false");
    expect(document.querySelectorAll("#inbox .inbox-item")).toHaveLength(2);
  });

  it("shows the count of jobs with an agent on them only while folded", async () => {
    setTree([
      node("job-1", { working: [{ conversationId: "1", name: "worker-a" }] }),
      node("job-2", { working: [] }),
      node("job-3", { working: [{ conversationId: "2", name: "worker-b" }] }, [
        node("job-4", { working: [{ conversationId: "3", name: "worker-c" }] }),
      ]),
    ]);
    await startSidePanels();
    await settle();

    // Open: the rows carry the marker themselves, so the heading says nothing.
    expect(workingBadge().className).toContain("hidden");
    expect(workingBadge().textContent).toBe("");

    await press("jobs");
    expect(workingBadge().className).not.toContain("hidden");
    // Three jobs have an agent on them, however many agents they hold.
    expect(workingBadge().textContent).toBe("3 working");
    expect(workingBadge().closest("h2")).not.toBeNull();

    // The work ends while the panel is folded, and the heading follows the tree.
    setTree([
      node("job-1", { working: [] }),
      node("job-2", { working: [] }),
      node("job-3", { working: [] }, [node("job-4", { working: [] })]),
    ]);
    vi.useFakeTimers();
    applyJobEvent("job_updated");
    await vi.advanceTimersByTimeAsync(JOBS_REFRESH_WINDOW_MS);
    vi.useRealTimers();
    await settle();

    expect(workingBadge().className).toContain("hidden");
    expect(workingBadge().textContent).toBe("");
    // The fold itself did not move: an emptied heading is still a folded panel.
    expect(foldButton("jobs").getAttribute("aria-expanded")).toBe("false");
  });

  it("shows a stopped machine only while the Machines panel is folded", async () => {
    setMachines([machine({ blocked: { reason: "host-key-mismatch", at: 1_793_430_000_000, detail: "Host key verification failed." } })]);
    await startSidePanels();
    await settle();

    // Open: the panel's own red line says it, so the heading stays quiet.
    expect(document.querySelector("#machines-panel .machine-block")).not.toBeNull();
    expect(stoppedBadge().className).toContain("hidden");

    await press("machines");
    expect(stoppedBadge().className).not.toContain("hidden");
    expect(stoppedBadge().textContent).toBe("stopped");
    expect(stoppedBadge().closest("h2")).not.toBeNull();

    await press("machines");
    expect(stoppedBadge().className).toContain("hidden");
  });

  it("draws no stopped warning while every machine is connected", async () => {
    setMachines([machine(), machine({ id: "box-b", address: "192.0.2.11" })]);
    await startSidePanels();
    await settle();

    await press("machines");

    expect(stoppedBadge().className).toContain("hidden");
    expect(stoppedBadge().textContent).toBe("");
  });
});

/* --------------------------------------------------- the shared folds */

/** The preference writes the page made, as the server read them. */
const writes = () =>
  calls
    .filter((call) => call.url === "/api/preferences" && call.method === "PATCH")
    .map((call) => JSON.parse(call.body ?? "{}") as Record<string, unknown>);

/** A screen of one class. `matches` is the answer of the narrow query. */
function screen(narrow: boolean): { cross(next: boolean): void } {
  let matches = narrow;
  const listeners = new Set<() => void>();
  vi.stubGlobal("matchMedia", () => ({
    get matches() {
      return matches;
    },
    addEventListener: (_name: string, listener: () => void) => listeners.add(listener),
    removeEventListener: (_name: string, listener: () => void) => listeners.delete(listener),
  }));
  (window as unknown as { matchMedia: unknown }).matchMedia = (globalThis as unknown as { matchMedia: unknown }).matchMedia;
  return {
    cross(next) {
      matches = next;
      for (const listener of listeners) listener();
    },
  };
}

describe("folds shared through the server", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete (window as unknown as { matchMedia?: unknown }).matchMedia;
  });

  it("saves a fold into the wide list on a wide screen, with the revision it last saw", async () => {
    await startSidePanels();
    await settle();

    await press("jobs");
    await settle();

    expect(writes()).toEqual([{ foldedWide: ["jobs"], baseRevision: 0 }]);
    expect(server.state()["foldedWide"]).toEqual(["jobs"]);
    expect(server.state()["foldedNarrow"]).toBeUndefined();
  });

  it("saves a fold into the narrow list on a narrow screen", async () => {
    screen(true);
    await mount();
    await startSidePanels();
    await settle();

    await press("inbox");
    await settle();

    expect(writes()).toEqual([{ foldedNarrow: ["inbox"], baseRevision: 0 }]);
  });

  it("draws the list of the new class when the screen crosses the boundary", async () => {
    const view = screen(false);
    await mount();
    server.external({ foldedWide: ["jobs"], foldedNarrow: ["inbox", "machines"] });
    await startSidePanels();
    await settle();
    expect(bodyFolds()).toEqual(["jobs"]);

    view.cross(true);
    await settle();
    expect(bodyFolds()).toEqual(["inbox", "machines"]);

    view.cross(false);
    await settle();
    expect(bodyFolds()).toEqual(["jobs"]);
    // Crossing is not a press: nothing was saved.
    expect(writes()).toEqual([]);
  });

  it("starts on the server's list and ignores the browser's cache once the server holds one", async () => {
    storeFolds(["inbox"]);
    await mount();
    server.external({ foldedWide: ["machines"] });
    await startSidePanels();
    await settle();

    expect(bodyFolds()).toEqual(["machines"]);
    // Adopting the server's list is not a press.
    expect(writes()).toEqual([]);
  });

  it("follows another browser's fold when the page reads the state again", async () => {
    await startSidePanels();
    await settle();
    expect(bodyFolds()).toEqual([]);

    server.external({ foldedWide: ["jobs", "inbox"] });
    const { readPreferences } = await import("../../src/ui/state/preferences.ts");
    await readPreferences();
    await settle();

    expect(bodyFolds()).toEqual(["inbox", "jobs"]);
    expect(writes()).toEqual([]);
  });

  it("carries the browser's old folds into the list of its screen class, when the server has none", async () => {
    storeFolds(["inbox", "machines"]);
    await mount();
    await startSidePanels();
    await settle();

    expect(writes()).toEqual([{ foldedWide: ["inbox", "machines"], seedOnly: true }]);
    expect(server.state()["foldedNarrow"]).toBeUndefined();
    expect(bodyFolds()).toEqual(["inbox", "machines"]);
  });

  it("carries nothing when the browser kept no folds, and nothing when the server has a list", async () => {
    await startSidePanels();
    await settle();
    expect(writes()).toEqual([]);

    storeFolds(["jobs"]);
    await mount();
    server.external({ foldedWide: [] });
    await startSidePanels();
    await settle();
    expect(writes()).toEqual([]);
    expect(bodyFolds()).toEqual([]);
  });
});
