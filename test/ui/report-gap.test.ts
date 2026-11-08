/**
 * The report page's assertions that the old page's tests made and the new page's
 * tests did not.
 *
 * Both are about the bar that sends an approval or a note, and both are about what
 * a press must not leave behind. An approval is a press with an empty field, so it
 * never reads, writes or clears a draft: the note in the field belongs to a
 * message, and an approval is not one. And a send leaves nothing in the tab's own
 * storage — the report page remembers no state there, so closing the tab loses
 * nothing that a later visit would misread.
 *
 * The old tests read the same two facts off the hand-written page: the draft entry
 * under `pi-sec:drafts::feedback:<id>` in `localStorage`, and the length of
 * `sessionStorage` after a send. That the store is untouched is read here as "no
 * write and no removal ran", which is the same thing said so that a write of
 * another value cannot pass.
 */
import { describe, expect, it } from "vitest";
import { loadUiPage, settle, type FetchAnswer, type UiPageHandle } from "./harness.ts";

/* ------------------------------------------------------------- fixtures */

/** One report with two revisions, feedback already left, and a live job. */
function makeReport(): Record<string, unknown> {
  return {
    id: "r1",
    jobId: "j1",
    name: "plan",
    title: "Plan",
    versions: [
      { n: 1, at: 1_000, bytes: 8, sha256: "a" },
      { n: 2, at: 2_000, note: "tweak", bytes: 8, sha256: "b" },
    ],
    feedback: [{ id: "f1", at: 3_000, body: "looks right", version: 2, from: "operator" }],
    createdAt: 1_000,
    updatedAt: 3_000,
    active: true,
    archived: false,
    status: "active",
    job: { id: "j1", title: "work", status: "active" },
  };
}

const BODIES: Readonly<Record<string, string>> = { "1": "# Plan\n\nfirst\n", "2": "# Plan\n\nsecond\n" };

/** The report's storage key: the mount is empty here, as the harness serves the root. */
const DRAFT_KEY = "pi-sec:drafts::feedback:r1";

/** Load the report viewer, which is where the bar is mounted. */
async function openViewer(): Promise<UiPageHandle> {
  const report = makeReport();
  const fetch: Record<string, FetchAnswer> = {
    "/api/reports/by-name/plan": () => ({ body: report }),
    "/api/reports/r1/versions/1": () => ({ text: BODIES["1"] ?? "" }),
    "/api/reports/r1/versions/2": () => ({ text: BODIES["2"] ?? "" }),
    "/api/reports/r1/approve": () => {
      // The record is written before the answer goes out, as the server does.
      (report.versions as { approval?: unknown }[])[1]!.approval = { at: 5_000, via: "viewer", sha256: "b" };
      return { status: 201, body: { at: 5_000, via: "viewer", sha256: "b" } };
    },
    "/api/reports/r1/feedback": () => ({ status: 201, body: {} }),
  };
  const page = await loadUiPage("report", { url: "/report/plan", fetch });
  await settle();
  await settle();
  return page;
}

/** The bar's field. */
function fieldOf(page: UiPageHandle): HTMLTextAreaElement {
  return page.document.getElementById("feedback-body") as HTMLTextAreaElement;
}

/** Write a text into the field the way a reader does, and let the bar draw it. */
async function type(page: UiPageHandle, text: string): Promise<void> {
  const field = fieldOf(page);
  field.value = text;
  field.dispatchEvent(new page.window.Event("input", { bubbles: true }));
  await settle();
}

/** Press the bar's one button, whatever state it is in, and let the send land. */
async function press(page: UiPageHandle): Promise<void> {
  page.document
    .getElementById("feedback-form")
    ?.dispatchEvent(new page.window.Event("submit", { cancelable: true, bubbles: true }));
  await settle();
  await settle();
}

/** What the page POSTed to one route, in order. */
function postsTo(page: UiPageHandle, path: string): RecordedPost[] {
  return page.fetchCalls
    .filter((call) => call.method === "POST" && call.path === path)
    .map((call) => JSON.parse(call.body ?? "{}") as RecordedPost);
}

interface RecordedPost {
  readonly version?: number;
  readonly body?: string;
  readonly via?: string;
}

/** The stored draft's text, or null when the store holds no entry for the report. */
function storedDraft(page: UiPageHandle): string | null {
  const raw = page.window.localStorage.getItem(DRAFT_KEY);
  return raw === null ? null : (JSON.parse(raw) as { text: string }).text;
}

describe("the report bar's empty-field press", () => {
  it("does not touch the draft when the field is empty, which is an approval", async () => {
    const page = await openViewer();
    try {
      // A note is typed, kept, and sent: the send takes the text and the entry.
      await type(page, "text");
      expect(storedDraft(page)).toBe("text");
      await press(page);
      expect(postsTo(page, "/api/reports/r1/feedback")).toEqual([{ body: "text", version: 2 }]);
      expect(storedDraft(page)).toBeNull();
      expect(fieldOf(page).value).toBe("");

      // Watch the store from here, so the approval press below has to leave it
      // alone: no write and no removal of any key.
      const proto = page.window.Storage.prototype;
      const setItem = proto.setItem;
      const removeItem = proto.removeItem;
      const touched: string[] = [];
      proto.setItem = function (key: string, value: string): void {
        touched.push(`set ${key}`);
        setItem.call(this, key, value);
      };
      proto.removeItem = function (key: string): void {
        touched.push(`remove ${key}`);
        removeItem.call(this, key);
      };
      try {
        await press(page);
      } finally {
        proto.setItem = setItem;
        proto.removeItem = removeItem;
      }

      // The press was an approval of the revision on screen, and only one.
      expect(postsTo(page, "/api/reports/r1/approve")).toEqual([{ version: 2, via: "viewer" }]);
      expect(postsTo(page, "/api/reports/r1/feedback")).toHaveLength(1);
      expect(touched).toEqual([]);
      expect(storedDraft(page)).toBeNull();
    } finally {
      page.close();
    }
  });
});

describe("the report page after a send", () => {
  it("writes nothing to the tab's storage after a send", async () => {
    const page = await openViewer();
    try {
      // The tab's own storage starts out empty on this page, which keeps no state
      // there; the send must not be what fills it.
      expect(page.window.sessionStorage.length).toBe(0);

      await type(page, "needs a summary");
      await press(page);

      expect(postsTo(page, "/api/reports/r1/feedback")).toEqual([{ body: "needs a summary", version: 2 }]);
      expect(page.window.sessionStorage.length).toBe(0);
    } finally {
      page.close();
    }
  });
});
