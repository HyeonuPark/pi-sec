// @vitest-environment jsdom
/**
 * The Machines panel in the sidebar.
 *
 * The panel is drawn from one route and redrawn on one frame, so these cases hold
 * the three things that could go wrong without a browser: the panel appears only
 * while a machine is registered, a press on the slider sends the level it names
 * and moves the mark at once, and a frame on the stream reads the list back.
 *
 * The shell is the real `src/web/index.html`, parsed into this document the way
 * `test/ui/chat-side-jobs.test.ts` does it, so the element the panel takes over is
 * the one the page carries.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mountSideParts, startSidePanels } from "../../src/ui/chat/SideParts.tsx";
import { resetJobsState } from "../../src/ui/state/jobs.ts";
import { resetInboxState } from "../../src/ui/state/inbox.ts";
import { resetQueriesState } from "../../src/ui/state/queries.ts";
import { resetNotesState } from "../../src/ui/state/notes.ts";
import {
  applyMachineEvent,
  applyMachinesAnswer,
  machines,
  markedLevel,
  readPending,
  resetMachinesState,
  setMachineLevel,
} from "../../src/ui/state/machines.ts";
import { pendingLine } from "../../src/ui/chat/machines/MachinesPanel.tsx";
import { applyJobEvent } from "../../src/ui/state/jobs.ts";

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

/** The four routes the sidebar reads besides this panel's own. */
function defaults(): void {
  answer("/api/jobs", () => ({ body: { tree: [] } }));
  answer("/api/preferences", () => ({ body: { hiddenJobs: [], expandedJobs: [], clearedInbox: [] } }));
  answer("/api/inbox", () => ({ body: { items: [] } }));
  answer("/api/user-queries", () => ({ body: { queries: [] } }));
  answer("/api/admin/status", () => ({ body: {} }));
}

/** One machine, as `GET /api/remote-machines` answers with it. */
function machine(over: Record<string, unknown> = {}) {
  return {
    id: "box-a",
    address: "192.0.2.10",
    port: 22,
    users: [
      { name: "alice", state: "reachable", since: 1_793_430_000_000, error: null },
      { name: "bob", state: "reachable", since: 1_793_430_000_000, error: null },
    ],
    level: "restricted",
    levelChangedAt: 1_793_430_000_000,
    pending: null,
    hostKey: "pinned",
    blocked: null,
    ...over,
  };
}

function setList(machines: unknown[], enabled = true): void {
  answer("/api/remote-machines", () => ({ body: { enabled, machines } }));
}

const panel = () => document.querySelector<HTMLElement>("#machines-panel")!;
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const posts = () => calls.filter((call) => call.method === "POST");

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
  vi.useRealTimers();
});

describe("the Machines panel", () => {
  it("hides itself while the config registers no machine", async () => {
    setList([]);
    await startSidePanels();
    await settle();
    expect(panel().className).toContain("hidden");
    // The route was read: the panel tells "no machine" from "never asked".
    expect(calls.some((call) => call.url === "/api/remote-machines")).toBe(true);
  });

  it("hides itself while the feature key is absent", async () => {
    setList([machine()], false);
    await startSidePanels();
    await settle();
    expect(panel().className).toContain("hidden");
  });

  it("draws one row per machine, with the level and one line per user", async () => {
    setList([
      machine(),
      machine({
        id: "box-b",
        address: "192.0.2.11",
        port: 2222,
        // A machine at off is answered this way by the server: nothing was
        // checked, whatever an earlier level found.
        users: [{ name: "carol", state: "not-checked", since: null, error: null }],
        level: "off",
      }),
    ]);
    await startSidePanels();
    await settle();

    expect(panel().className).not.toContain("hidden");
    const rows = [...panel().querySelectorAll<HTMLElement>("[data-machine-row]")];
    expect(rows.map((row) => row.dataset.machineRow)).toEqual(["box-a", "box-b"]);
    // The address carries the port only when it is not the default.
    expect(rows[0]!.querySelector(".machine-address")!.textContent).toBe("192.0.2.10");
    expect(rows[1]!.querySelector(".machine-address")!.textContent).toBe("192.0.2.11:2222");
    // The level is a word on a pressed button, not colour alone.
    const marked = [...rows[0]!.querySelectorAll<HTMLElement>(".machine-level-button.marked")];
    expect(marked.map((button) => button.textContent)).toEqual(["restricted"]);
    expect(marked[0]!.getAttribute("aria-pressed")).toBe("true");
    // A machine at off says its users were not checked, which is not a failure.
    const off = [...rows[1]!.querySelectorAll<HTMLElement>(".machine-user")];
    expect(off.map((line) => line.dataset.linkState)).toEqual(["not-checked"]);
    expect(off[0]!.textContent).toBe("carol · not checked (off)");
    // A reachable line is the user and the state word, and nothing else.
    expect(rows[0]!.querySelector(".machine-user")!.textContent).toBe("alice · reachable");
  });

  it("sends the pressed level and marks it before the answer arrives", async () => {
    setList([machine()]);
    let release: (() => void) | undefined;
    answer("/api/remote-machines/box-a/level", () => {
      return new Promise((resolve) => {
        release = () => resolve({ body: machine({ level: "on" }) });
      });
    });
    await startSidePanels();
    await settle();

    const on = panel().querySelector<HTMLElement>('[data-machine-level="on"]')!;
    on.click();
    // The press is sent with the level it named, and the mark moves at once: a
    // press that looked ignored would be pressed again.
    expect(posts().map((call) => call.url)).toEqual(["/api/remote-machines/box-a/level"]);
    expect(JSON.parse(posts()[0]!.body ?? "{}")).toEqual({ level: "on" });
    expect(markedLevel({ id: "box-a", level: "restricted" } as never)).toBe("on");

    release?.();
    await settle();
    const marked = [...panel().querySelectorAll<HTMLElement>(".machine-level-button.marked")];
    expect(marked.map((button) => button.textContent)).toEqual(["on"]);
  });

  it("marks the level of the last press when two answers come back in reverse order", async () => {
    setList([machine()]);
    const releases = new Map<string, () => void>();
    answer("/api/remote-machines/box-a/level", (call) => {
      const level = (JSON.parse(call.body ?? "{}") as { level: string }).level;
      return new Promise((resolve) => {
        releases.set(level, () => resolve({ body: machine({ level }) }));
      });
    });
    await startSidePanels();
    await settle();

    panel().querySelector<HTMLElement>('[data-machine-level="on"]')!.click();
    panel().querySelector<HTMLElement>('[data-machine-level="off"]')!.click();
    expect(posts()).toHaveLength(2);
    releases.get("off")?.();
    await settle();
    releases.get("on")?.();
    await settle();

    const marked = [...panel().querySelectorAll<HTMLElement>(".machine-level-button.marked")];
    expect(marked.map((button) => button.textContent)).toEqual(["off"]);
    expect(panel().querySelector(".machine-level-button.waiting, [data-waiting]")).toBeNull();
    expect(markedLevel({ id: "box-a", level: "off" } as never)).toBe("off");
  });

  it("writes the reason under the slider when the server refuses the press", async () => {
    setList([machine()]);
    answer("/api/remote-machines/box-a/level", () => ({
      status: 400,
      body: { error: { code: "invalid_level", message: "level must be one of off, restricted or on", requestId: "r1" } },
    }));
    await startSidePanels();
    await settle();

    panel().querySelector<HTMLElement>('[data-machine-level="off"]')!.click();
    await settle();

    const error = panel().querySelector<HTMLElement>(".machine-error");
    expect(error).not.toBeNull();
    expect(error!.textContent).toContain("level must be one of");
    // The mark goes back to what the server last said, so the panel does not show
    // a level the server refused.
    const marked = [...panel().querySelectorAll<HTMLElement>(".machine-level-button.marked")];
    expect(marked.map((button) => button.textContent)).toEqual(["restricted"]);
  });

  it("shows a stopped machine as one red line", async () => {
    setList([
      machine({
        blocked: { reason: "host-key-mismatch", at: 1_793_430_000_000, detail: "Host key verification failed." },
        users: [
          { name: "alice", state: "unreachable", since: 1_793_430_000_000, error: "Host key verification failed." },
          { name: "bob", state: "unreachable", since: 1_793_430_000_000, error: "Host key verification failed." },
        ],
      }),
    ]);
    await startSidePanels();
    await settle();
    const line = panel().querySelector<HTMLElement>(".machine-block");
    expect(line).not.toBeNull();
    expect(line!.textContent).toContain("host key mismatch: connections stopped");
    expect(line!.getAttribute("title")).toBe("Host key verification failed.");
  });

  it("says the host key is not pinned, and draws no block", async () => {
    setList([machine({ hostKey: "unpinned", level: "restricted", users: [{ name: "alice", state: "unknown" }] })]);
    await startSidePanels();
    await settle();
    expect(panel().querySelector(".machine-note")!.textContent).toBe("host key not pinned");
    expect(panel().querySelector(".machine-block")).toBeNull();
  });

  it("reads the list back when the stream says a machine changed", async () => {
    setList([machine()]);
    await startSidePanels();
    await settle();
    const readsAfterMount = calls.filter((call) => call.url === "/api/remote-machines").length;

    // The server must not refresh the panel on `extension_reloaded`: that frame
    // goes out before the new config is in place. This frame comes after it.
    setList([machine({ level: "on" })]);
    applyJobEvent("job_updated");
    applyMachineEvent();
    await settle();
    await new Promise((resolve) => setTimeout(resolve, 600));

    expect(calls.filter((call) => call.url === "/api/remote-machines").length).toBeGreaterThan(readsAfterMount);
    const marked = [...panel().querySelectorAll<HTMLElement>(".machine-level-button.marked")];
    expect(marked.map((button) => button.textContent)).toEqual(["on"]);
  });

  it("keeps the list when a read fails", async () => {
    setList([machine()]);
    await startSidePanels();
    await settle();
    answer("/api/remote-machines", () => ({ status: 500, body: { error: { code: "internal_error", message: "boom", requestId: "r" } } }));
    await setMachineLevel("box-a", "on");
    // A refused press leaves the machine as it was drawn.
    const marked = [...panel().querySelectorAll<HTMLElement>(".machine-level-button.marked")];
    expect(marked.map((button) => button.textContent)).toEqual(["restricted"]);
  });
});

describe("the wait a tightening spends", () => {
  it("reads the new shape, a null and a missing field into the same one", () => {
    const wait = { level: "off", since: 1_793_430_000_000, deadline: 1_793_430_300_000, runs: 2 };
    expect(readPending(wait)).toEqual(wait);
    // Stage 1 declared the field as always null, and an older server sends no
    // field at all: both mean "nothing waits".
    expect(readPending(null)).toBeNull();
    expect(readPending(undefined)).toBeNull();
    // A wait the panel could not write a line for is read as no wait.
    expect(readPending({ level: "sideways", runs: 1 })).toBeNull();
    expect(readPending({ level: "on" })).toBeNull();
    expect(readPending("on")).toBeNull();
  });

  it("keeps the wait on the list, and gives a machine without the field a null", () => {
    const { pending: _dropped, ...withoutPending } = machine({ level: "off" }) as Record<string, unknown>;
    applyMachinesAnswer({
      enabled: true,
      machines: [
        machine({ level: "off", pending: { level: "off", since: 1, deadline: 2, runs: 3 } }),
        withoutPending,
      ],
    } as never);
    expect(machines.value.map((entry) => entry.pending)).toEqual([
      { level: "off", since: 1, deadline: 2, runs: 3 },
      null,
    ]);
  });

  it("draws the waiting level in its own colour with one line under the slider", async () => {
    setList([
      machine({
        level: "off",
        pending: { level: "off", since: 1_793_430_000_000, deadline: 1_793_430_300_000, runs: 2 },
      }),
    ]);
    await startSidePanels();
    await settle();

    // The level the slider moved to is the one drawn as waiting, and it is still
    // the level the machine holds: the server stores it before the runs stop.
    const waiting = panel().querySelector<HTMLElement>('[data-machine-level="off"]')!;
    expect(waiting.className).toContain("pending");
    expect(waiting.className).not.toContain("marked");
    expect(waiting.getAttribute("aria-pressed")).toBe("true");
    expect(waiting.dataset.machineWaiting).toBe("true");
    // The line is text, so the colour is not the only sign.
    expect(panel().querySelector<HTMLElement>(".machine-pending")!.textContent).toBe("pending: stopping 2 runs");
    // One run is said in the singular.
    expect(pendingLine(machine({ pending: { level: "off", since: 1, deadline: 2, runs: 1 } }) as never)).toBe(
      "pending: stopping 1 run",
    );
  });

  it("adds why nothing can be stopped while every user is unreachable", async () => {
    setList([
      machine({
        level: "restricted",
        users: [
          { name: "alice", state: "unreachable", since: 1_793_430_000_000, error: "No route to host" },
          { name: "bob", state: "unreachable", since: 1_793_430_000_000, error: "No route to host" },
        ],
        pending: { level: "restricted", since: 1, deadline: 2, runs: 1 },
      }),
    ]);
    await startSidePanels();
    await settle();
    expect(panel().querySelector<HTMLElement>(".machine-pending")!.textContent).toBe(
      "pending: stopping 1 run, no connection",
    );
  });

  it("returns to the applied shape when the wait ends", async () => {
    setList([machine({ level: "off", pending: { level: "off", since: 1, deadline: 2, runs: 2 } })]);
    await startSidePanels();
    await settle();
    expect(panel().querySelector(".machine-pending")).not.toBeNull();

    // The core clears the wait and says so on the stream; the same read that
    // follows any machine change clears the line and the colour.
    setList([machine({ level: "off", pending: null })]);
    applyMachineEvent();
    await settle();
    await new Promise((resolve) => setTimeout(resolve, 600));

    expect(panel().querySelector(".machine-pending")).toBeNull();
    const marked = panel().querySelector<HTMLElement>('[data-machine-level="off"]')!;
    expect(marked.className).toContain("marked");
    expect(marked.className).not.toContain("pending");
  });
});
