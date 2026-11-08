// @vitest-environment jsdom
/**
 * Awaiting you: the question cards.
 *
 * These are the assertions `test/web-ui.test.ts` made on `renderQueries` (a
 * question that was already pending when the page opened, every open question on
 * its own card keyed by its key, the age stamp, the answer that goes out by key
 * and is followed by a read, the answer in the operator's own words) moved onto
 * the new component, plus the `Enter` rule the composer uses, plus the reset test:
 * what is typed into `Other…`, its caret and its focus must survive a new
 * question, a question that closed, a read and a return to the tab.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mountSideParts, startSidePanels } from "../../src/ui/chat/SideParts.tsx";
import { resetInboxState } from "../../src/ui/state/inbox.ts";
import { resetJobsState } from "../../src/ui/state/jobs.ts";
import { applyQueryEvent, refreshQueries, resetQueriesState } from "../../src/ui/state/queries.ts";
import { resetNotesState } from "../../src/ui/state/notes.ts";

/* ------------------------------------------------------------ the page */

interface Call {
  readonly url: string;
  readonly method: string;
  readonly body: string | null;
}

type Answer = { readonly status?: number; readonly body?: unknown } | Promise<{ readonly status?: number; readonly body?: unknown }>;

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
  answer("/api/admin/status", () => ({ body: {} }));
}

/** The questions the next read answers with. */
function setQueries(list: unknown[]): void {
  answer("/api/user-queries", (call) => (call.method === "GET" ? { body: { queries: list } } : { body: {} }));
}

/** One open question, as `GET /api/user-queries` answers it. */
function pending(key: string, question: string) {
  return { key, id: `id-${key}`, conversationId: "1", question, options: ["Yes", "No"], createdAt: 1 };
}

const field = () => document.querySelector<HTMLInputElement>("#queries .query input")!;
const sendButton = () => document.querySelector<HTMLElement>("#queries [data-other]")!;
const cards = () => document.querySelectorAll("#queries .query");
const posts = () => calls.filter((call) => call.method === "POST" && call.url.includes("/api/user-queries"));
const reads = () => calls.filter((call) => call.method === "GET" && call.url.includes("/api/user-queries"));
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

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
  await installShell();
  Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
  defaults();
  resetJobsState();
  resetInboxState();
  resetQueriesState();
  resetNotesState();
  mountSideParts();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("the questions", () => {
  it("draws a question that was already pending when the page opened", async () => {
    setQueries([pending("q1", "which account should this go to?")]);
    await startSidePanels();
    await settle();

    expect(document.querySelector("#queries")!.textContent).toContain("which account should this go to?");
    expect(document.querySelectorAll("#queries button[data-choice]")).toHaveLength(2);
    const card = document.querySelector<HTMLElement>("#queries .query")!;
    expect(card.dataset.key).toBe("q1");
    expect(card.querySelector(".inbox-title")!.textContent).toBe("which account should this go to?");
    expect(card.querySelectorAll("[data-choice]")[1]!.textContent).toBe("No");
  });

  it("draws every open question, so they can be answered one at a time", async () => {
    setQueries([pending("q1", "the first question"), pending("q2", "the second question")]);
    await startSidePanels();
    await settle();

    expect(cards()).toHaveLength(2);
    expect(document.querySelector<HTMLElement>("#queries .query")!.dataset.key).toBe("q1");
    expect(document.querySelector("#queries")!.textContent).toContain("the second question");
  });

  it("stamps the card with when the question was asked, and with no deadline", async () => {
    setQueries([pending("q1", "which account?")]);
    await startSidePanels();
    await settle();

    const age = document.querySelector<HTMLElement>("#queries .query-age")!;
    expect(age.textContent!.startsWith("asked ")).toBe(true);
    expect(age.textContent!.length).toBeGreaterThan("asked ".length);
    expect(age.textContent).not.toMatch(/deadline|left|overdue/i);
  });

  it("answers by the question's key, not its id, and reads the list back afterwards", async () => {
    setQueries([pending("q1", "which account?")]);
    await startSidePanels();
    await settle();
    const before = reads().length;

    document.querySelector<HTMLElement>('#queries button[data-choice="1"]')!.click();
    await settle();

    expect(posts()).toHaveLength(1);
    expect(posts()[0]!.url).toBe("/api/user-queries/q1");
    expect(JSON.parse(posts()[0]!.body!)).toEqual({ choice: 1 });
    expect(reads().length).toBeGreaterThan(before);
  });

  it("answers in the operator's own words with the text in the field", async () => {
    setQueries([pending("q1", "which account?")]);
    await startSidePanels();
    await settle();

    field().value = "to the shared mailbox";
    sendButton().click();
    await settle();

    expect(posts()).toHaveLength(1);
    expect(posts()[0]!.url).toBe("/api/user-queries/q1");
    expect(JSON.parse(posts()[0]!.body!)).toEqual({ other: "to the shared mailbox" });
  });

  it("sends on Enter, and sends nothing while an input method composes or a key repeats", async () => {
    setQueries([pending("q1", "which account?")]);
    await startSidePanels();
    await settle();

    const press = (init: KeyboardEventInit) => {
      field().value = "to the shared mailbox";
      field().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true, ...init }));
    };

    // An Enter that commits a composition belongs to the input method.
    press({ isComposing: true });
    press({ keyCode: 229 });
    // A held key fires repeats; they send nothing.
    press({ repeat: true });
    // Anything but Enter is the field's own business.
    press({ key: "a" });
    await settle();
    expect(posts()).toHaveLength(0);

    press({});
    await settle();
    expect(posts()).toHaveLength(1);
    expect(JSON.parse(posts()[0]!.body!)).toEqual({ other: "to the shared mailbox" });
  });

  it("sends the same answer once, even while it is still on its way", async () => {
    let release: (() => void) | undefined;
    setQueries([pending("q1", "which account?")]);
    answer(
      "/api/user-queries/q1",
      () => new Promise((resolve) => {
        release = () => resolve({ body: { status: "resolved" } });
      }),
    );
    await startSidePanels();
    await settle();

    field().value = "to the shared mailbox";
    sendButton().click();
    await settle();
    sendButton().click();
    await settle();

    // The card is redrawn from every read, so the guard lives beside the list: the
    // answer still on its way is the same answer after the redraw.
    expect(posts()).toHaveLength(1);
    release!();
    await settle();
    expect(posts()).toHaveLength(1);

    // Once it is through, the same words are a new answer again.
    sendButton().click();
    await settle();
    expect(posts()).toHaveLength(2);
  });

  it("reads the list back on a user_query frame, and says nothing is pending when it is empty", async () => {
    await startSidePanels();
    await settle();
    expect(document.querySelector("#queries")!.textContent).toContain("Nothing pending.");

    setQueries([pending("q1", "a new question")]);
    const before = reads().length;
    applyQueryEvent("user_query");
    await settle();

    expect(reads().length).toBe(before + 1);
    expect(cards()).toHaveLength(1);
    expect(document.querySelector("#queries")!.textContent).toContain("a new question");
  });

  it("keeps what is typed, its caret and its focus through every refresh", async () => {
    setQueries([pending("q1", "the first question")]);
    await startSidePanels();
    await settle();

    field().value = "half a sentence";
    field().focus();
    field().setSelectionRange(4, 4);
    const input = field();
    const card = document.querySelector("#queries .query")!;
    const caret = () => [field(), field().value, field().selectionStart, field().selectionEnd, document.activeElement];

    // A new question arrives, and the list is read back.
    setQueries([pending("q1", "the first question"), pending("q2", "the second question")]);
    applyQueryEvent("user_query");
    await settle();
    expect(cards()).toHaveLength(2);
    expect(caret()).toEqual([input, "half a sentence", 4, 4, input]);

    // Another question closes, and the list is read back again.
    setQueries([pending("q1", "the first question")]);
    applyQueryEvent("user_query_resolved");
    await settle();
    expect(cards()).toHaveLength(1);
    expect(document.querySelector("#queries .query")).toBe(card);
    expect(caret()).toEqual([input, "half a sentence", 4, 4, input]);

    // The tab comes back: the age is measured again without a read, and the card
    // is not rebuilt.
    const readsBefore = reads().length;
    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
    await settle();
    expect(reads().length).toBe(readsBefore);
    expect(caret()).toEqual([input, "half a sentence", 4, 4, input]);

    // A plain read changes nothing either.
    await refreshQueries();
    await settle();
    expect(caret()).toEqual([input, "half a sentence", 4, 4, input]);

    // The question is answered, so its card leaves, and its text with it.
    setQueries([]);
    applyQueryEvent("user_query_resolved");
    await settle();
    expect(cards()).toHaveLength(0);
    expect(document.querySelector("#queries")!.textContent).toContain("Nothing pending.");
  });
});
