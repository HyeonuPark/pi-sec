/**
 * The feedback bar: one control, two states, and the text nobody sent yet.
 *
 * The bar is where an approval and a note are written, so it is the part of the
 * report page where a wrong redraw costs the reader work. These tests hold three
 * things: the button follows the server's answer rather than the screen's hope,
 * the field keeps what is being typed through a report that is read again,
 * and the text is kept per report, in the same entry the chat's report panel
 * reads.
 *
 * The panel case is driven against the component itself, because the chat page is
 * another branch's file: the bar takes the surface it is mounted for as a prop,
 * and `via: "panel"` is what the server records on such an approval.
 */
import { JSDOM } from "jsdom";
import { h, render } from "preact";
import { describe, expect, it, vi } from "vitest";
import { FeedbackBar } from "../../src/ui/components/feedback.tsx";
import { loadUiPage, settle, type FetchAnswer, type UiPageHandle } from "./harness.ts";

/* ------------------------------------------------------------- fixtures */

interface ReportFixture {
  id: string;
  jobId: string;
  name: string;
  title: string;
  versions: { n: number; at: number; note?: string; bytes: number; sha256: string; approval?: unknown }[];
  feedback: { id: string; at: number; body: string; version?: number; from: string }[];
  createdAt: number;
  updatedAt: number;
  active: boolean;
  archived: boolean;
  status?: string;
  job: { id: string; title: string; status: string } | null;
}

function makeReport(): ReportFixture {
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

interface BarOptions {
  /** What `POST /api/reports/:id/approve` answers. */
  readonly approve?: { status?: number; body?: unknown };
  /** What `POST /api/reports/:id/feedback` answers. */
  readonly feedback?: { status?: number; body?: unknown };
}

interface OpenBar {
  readonly page: UiPageHandle;
  readonly report: ReportFixture;
}

/** Load the report viewer, which is where the bar is mounted. */
async function openBar(options: BarOptions = {}): Promise<OpenBar> {
  const report = makeReport();
  const approve = options.approve;
  const feedback = options.feedback;
  const fetch: Record<string, FetchAnswer> = {
    "/api/reports/by-name/plan": () => ({ body: report }),
    "/api/reports/r1/versions/1": () => ({ text: BODIES["1"] ?? "" }),
    "/api/reports/r1/versions/2": () => ({ text: BODIES["2"] ?? "" }),
    "/api/reports/r1/approve": () => {
      const status = approve?.status ?? 201;
      // The record is written before the answer goes out, so the read that follows
      // an approval sees what a real server would have written.
      if (status < 400) report.versions[1]!.approval = { at: 5_000, via: "viewer", sha256: "b" };
      return { status, body: approve?.body ?? { at: 5_000, via: "viewer", sha256: "b" } };
    },
    "/api/reports/r1/feedback": () => ({ status: feedback?.status ?? 201, body: feedback?.body ?? {} }),
  };
  const page = await loadUiPage("report", { url: "/report/plan", fetch });
  await settle();
  await settle();
  return { page, report };
}

/** The bar's three parts. */
function fieldOf(page: UiPageHandle): HTMLTextAreaElement {
  return page.document.getElementById("feedback-body") as HTMLTextAreaElement;
}

function buttonOf(page: UiPageHandle): HTMLButtonElement {
  return page.document.getElementById("feedback-submit") as HTMLButtonElement;
}

function hintOf(page: UiPageHandle): HTMLElement {
  return page.document.getElementById("feedback-hint") as HTMLElement;
}

/**
 * Write a text into the field the way a reader does, and let the page draw what
 * changed. A keystroke reaches the bar and the bar draws on the next turn, so a
 * check that runs before that is a check about the wrong screen.
 */
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

/** What the page POSTed, in order. */
function posts(page: UiPageHandle): { path: string; body: unknown }[] {
  return page.fetchCalls
    .filter((call) => call.method === "POST")
    .map((call) => ({ path: call.path, body: call.body === null ? null : JSON.parse(call.body) }));
}

/* ------------------------------------------------------------- the button */

describe("the feedback bar's one button", () => {
  it("switches between Approve and Feedback with the field", async () => {
    const { page } = await openBar();
    try {
      expect(buttonOf(page).textContent).toBe("Approve");
      expect(buttonOf(page).classList.contains("button-approve")).toBe(true);
      expect(buttonOf(page).getAttribute("aria-label")).toBe("Approve");
      expect(buttonOf(page).disabled).toBe(false);

      await type(page, "needs a summary");
      expect(buttonOf(page).textContent).toBe("Feedback");
      expect(buttonOf(page).classList.contains("button-feedback")).toBe(true);
      expect(buttonOf(page).getAttribute("aria-label")).toBe("Feedback");

      // Whitespace is not feedback, so the button goes back to Approve.
      await type(page, "   ");
      expect(buttonOf(page).textContent).toBe("Approve");
    } finally {
      page.close();
    }
  });

  it("names the control feedback in the bar and in the viewer", async () => {
    const { page } = await openBar();
    try {
      expect(fieldOf(page).getAttribute("placeholder")).toBe("Leave feedback for pi-sec…");
      expect(fieldOf(page).getAttribute("aria-label")).toBe("Feedback");
      expect(page.document.querySelector(".report-feedback .report-h2")?.textContent).toBe("Feedback");
      expect(page.document.querySelector("#report-notes")?.textContent).toContain("looks right");
    } finally {
      page.close();
    }
  });

  it("posts feedback and returns to the list", async () => {
    const { page } = await openBar();
    try {
      await type(page, "needs a summary");
      await press(page);
      await settle();
      await settle();

      expect(posts(page)).toEqual([{ path: "/api/reports/r1/feedback", body: { body: "needs a summary", version: 2 } }]);
      // The send does not stay on the report: the list is read fresh when it
      // arrives. jsdom does not navigate, so the address is the whole of it.
      expect(page.window.piSecReport?.listUrl()).toBe("/report");
      // The server took the text, so the field is empty again.
      expect(fieldOf(page).value).toBe("");
      // Nothing is written to the tab's storage on the way: the list is read fresh
      // when it opens, and there is no record of where the reader came from.
      expect(page.window.sessionStorage.length).toBe(0);
    } finally {
      page.close();
    }
  });

  it("approves the revision on screen when the field is empty", async () => {
    const { page } = await openBar();
    try {
      await press(page);
      await settle();
      await settle();

      expect(posts(page)).toEqual([{ path: "/api/reports/r1/approve", body: { version: 2, via: "viewer" } }]);
      expect(page.window.piSecReport?.listUrl()).toBe("/report");
    } finally {
      page.close();
    }
  });

  it("names the surface it was mounted for", async () => {
    const { page } = await openBar();
    const sent: { path: string; body: unknown }[] = [];
    const host = page.document.createElement("div");
    page.document.body.appendChild(host);
    // The chat's report panel mounts the same component with a surface of its own.
    // It is exercised against the page's document, so the draft store it reads is
    // the one the page reads.
    vi.stubGlobal("document", page.document);
    vi.stubGlobal("window", page.window);
    try {
      render(
        h(FeedbackBar, {
          target: { id: "r1", version: 2, latest: 2, active: true },
          via: "panel",
          send: async (path: string, options?: { body?: string }) => {
            sent.push({ path, body: options?.body === undefined ? undefined : JSON.parse(options.body) });
            return { at: 1, via: "panel", sha256: "b" };
          },
        }),
        host,
      );
      await settle();
      host
        .querySelector("#feedback-form")
        ?.dispatchEvent(new page.window.Event("submit", { cancelable: true, bubbles: true }));
      await settle();
      await settle();
      expect(sent).toEqual([{ path: "/api/reports/r1/approve", body: { version: 2, via: "panel" } }]);
    } finally {
      vi.unstubAllGlobals();
      host.remove();
      page.close();
    }
  });
});

/* ------------------------------------------------------------ the refusals */

describe("what the server says about an approval", () => {
  it("disables Approve on a revision that is not the newest", async () => {
    const { page } = await openBar();
    try {
      const select = page.document.querySelector("#version-select") as HTMLSelectElement;
      select.value = "1";
      select.dispatchEvent(new page.window.Event("change"));
      await settle();
      await settle();

      expect(buttonOf(page).textContent).toBe("Approve");
      expect(buttonOf(page).disabled).toBe(true);
      expect(hintOf(page).textContent).toContain("Only the newest revision");

      await press(page);
      await settle();
      expect(posts(page)).toHaveLength(0);
    } finally {
      page.close();
    }
  });

  it("turns a stale revision answer into a disabled Approve with the reason", async () => {
    const { page } = await openBar({
      approve: {
        status: 409,
        body: { error: { code: "stale_revision", message: "revision 2 is not the newest" }, latest: 3, latestSha256: "c" },
      },
    });
    try {
      await press(page);
      await settle();
      await settle();

      expect(buttonOf(page).textContent).toBe("Approve");
      expect(buttonOf(page).disabled).toBe(true);
      expect(hintOf(page).textContent).toContain("Only the newest revision");
    } finally {
      page.close();
    }
  });

  it("reads an already-approved answer as approved", async () => {
    const { page } = await openBar({
      approve: { status: 409, body: { error: { code: "already_approved", message: "revision 2 is already approved" } } },
    });
    try {
      await press(page);
      await settle();
      await settle();

      expect(buttonOf(page).textContent).toBe("Approved");
      expect(buttonOf(page).disabled).toBe(true);
    } finally {
      page.close();
    }
  });

  it("takes the newest revision the server names in a stale answer", async () => {
    const { page } = await openBar({
      approve: {
        status: 409,
        body: { error: { code: "stale_revision", message: "revision 2 is not the newest" }, latest: 3, latestSha256: "c" },
      },
    });
    try {
      // The answer says which revision can be approved, and the bar takes it: it
      // now aims at v3 while v2 is on screen, which is what holds Approve off.
      await press(page);
      await settle();
      await settle();

      expect(buttonOf(page).textContent).toBe("Approve");
      expect(buttonOf(page).disabled).toBe(true);
      // One sentence, the one the hand-written feedback module built in its
      // `fail()`: the
      // revision the bar took is not named on screen again.
      expect(hintOf(page).textContent).toBe("Only the newest revision can be approved.");

      // The aim is what a second press is judged against, so this is where the
      // revision the answer named shows: an aim still at v2 would leave Approve
      // pressable and send the approval a second time.
      await press(page);
      expect(posts(page)).toHaveLength(1);
    } finally {
      page.close();
    }
  });

  it("reads the approval record out of an already-approved answer", async () => {
    const at = Date.now() - 2 * 60 * 60 * 1000;
    const { page } = await openBar({
      approve: {
        status: 409,
        body: {
          error: { code: "already_approved", message: "revision 2 is already approved" },
          approval: { at, via: "viewer", sha256: "b" },
        },
      },
    });
    try {
      // The record rides beside the envelope, and its time is what the bar draws
      // next to the revision: the refusal leaves the same screen a report read
      // after the approval would.
      await press(page);
      await settle();
      await settle();

      expect(buttonOf(page).textContent).toBe("Approved");
      expect(buttonOf(page).disabled).toBe(true);
      expect(hintOf(page).textContent).toBe("Approved v2 · 2h ago");
    } finally {
      page.close();
    }
  });

  it("keeps the text being written while a refusal corrects the bar", async () => {
    const at = Date.now() - 2 * 60 * 60 * 1000;
    const { page } = await openBar({
      approve: {
        status: 409,
        body: {
          error: { code: "already_approved", message: "revision 2 is already approved" },
          approval: { at, via: "viewer", sha256: "b" },
        },
      },
    });
    try {
      // The press was made with an empty field, and the reader starts writing
      // before the answer lands. What the server says corrects the button, not the
      // field: the text, the element and its focus stay where they are.
      page.document
        .getElementById("feedback-form")
        ?.dispatchEvent(new page.window.Event("submit", { cancelable: true, bubbles: true }));
      fieldOf(page).focus();
      fieldOf(page).value = "half a sentence";
      fieldOf(page).dispatchEvent(new page.window.Event("input", { bubbles: true }));
      const fieldBefore = page.capture("#feedback-body");
      await settle();
      await settle();

      page.expectUntouched(fieldBefore);
      expect(fieldOf(page).value).toBe("half a sentence");
      expect(buttonOf(page).textContent).toBe("Feedback");
      // The correction still landed: the approval it was refused for is on screen.
      expect(hintOf(page).textContent).toContain("Approved v2");
    } finally {
      page.close();
    }
  });

  it("says the job has finished when the answer is not_active", async () => {
    const { page } = await openBar({
      approve: { status: 409, body: { error: { code: "not_active", message: "the report is not live" }, status: "done" } },
    });
    try {
      await press(page);
      await settle();
      await settle();

      expect(buttonOf(page).disabled).toBe(true);
      expect(hintOf(page).textContent).toContain("job has finished");
    } finally {
      page.close();
    }
  });

  it("keeps the reader on the report when the approval fails", async () => {
    const { page } = await openBar({
      approve: { status: 500, body: { error: { code: "internal", message: "boom", requestId: "q1" } } },
    });
    try {
      await press(page);
      await settle();
      await settle();

      // A send that did not land is not a reason to walk away from the screen it
      // was written on: nothing is stored, and the button is live again.
      expect(buttonOf(page).textContent).toBe("Approve");
      expect(buttonOf(page).disabled).toBe(false);
      expect(page.document.getElementById("toast")?.textContent).toContain("boom");
    } finally {
      page.close();
    }
  });
});

/* -------------------------------------------------------------- the draft */

describe("the text nobody sent yet", () => {
  it("keeps the text being written when the report is read again", async () => {
    const { page } = await openBar();
    try {
      await type(page, "half a sentence");
      fieldOf(page).focus();
      const fieldBefore = page.capture("#feedback-body");
      const buttonBefore = page.capture("#feedback-submit");

      // A page restored from the back/forward cache reads the report again; a new
      // revision or a recorded approval does the same. None of it is about the
      // field.
      page.pageShow(true);
      await settle();
      await settle();
      await settle();

      expect(page.fetchCalls.filter((call) => call.path === "/api/reports/by-name/plan")).toHaveLength(2);
      page.expectUntouched(fieldBefore);
      page.expectUntouched(buttonBefore);
      expect(fieldOf(page).value).toBe("half a sentence");
      expect(buttonOf(page).textContent).toBe("Feedback");
    } finally {
      page.close();
    }
  });

  it("files the text under the report, in the entry the panel reads too", async () => {
    const { page } = await openBar();
    try {
      await type(page, "keep this");
      const stored = page.window.localStorage.getItem("pi-sec:drafts::feedback:r1");
      expect(stored).not.toBeNull();
      expect(JSON.parse(stored ?? "{}")).toMatchObject({ text: "keep this" });
      // The revision is not part of the key: a new revision must not drop the text.
      expect(page.window.localStorage.getItem("pi-sec:drafts::feedback:r1@v2")).toBeNull();
    } finally {
      page.close();
    }
  });

  it("brings the stored text back when the report is opened", async () => {
    // A page whose store already holds a text: the bar is pointed at the report
    // and reads that entry, which is what a reload or the panel does.
    const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/report/plan" });
    dom.window.localStorage.setItem(
      "pi-sec:drafts::feedback:r1",
      JSON.stringify({ text: "written before the reload", at: Date.now() }),
    );
    const host = dom.window.document.createElement("div");
    dom.window.document.body.appendChild(host);
    vi.stubGlobal("document", dom.window.document);
    vi.stubGlobal("window", dom.window);
    try {
      render(h(FeedbackBar, { target: { id: "r1", version: 2, latest: 2, active: true }, send: async () => ({}) }), host);
      await settle();
      expect((host.querySelector("#feedback-body") as HTMLTextAreaElement).value).toBe("written before the reload");
      expect(host.querySelector("#feedback-submit")?.textContent).toBe("Feedback");
    } finally {
      vi.unstubAllGlobals();
      dom.window.close();
    }
  });

  it("loads the stored text of the report it is pointed at", async () => {
    // Two reports, two entries: pointing the bar at another report takes that
    // report's text, and coming back takes the first one again.
    const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/report/plan" });
    dom.window.localStorage.setItem("pi-sec:drafts::feedback:r1", JSON.stringify({ text: "about r1", at: Date.now() }));
    dom.window.localStorage.setItem("pi-sec:drafts::feedback:r2", JSON.stringify({ text: "about r2", at: Date.now() }));
    const host = dom.window.document.createElement("div");
    dom.window.document.body.appendChild(host);
    vi.stubGlobal("document", dom.window.document);
    vi.stubGlobal("window", dom.window);
    const send = async (): Promise<unknown> => ({});
    const fieldValue = (): string => (host.querySelector("#feedback-body") as HTMLTextAreaElement).value;
    const pointAt = async (id: string): Promise<void> => {
      render(h(FeedbackBar, { target: { id, version: 1, latest: 1, active: true }, send }), host);
      await settle();
    };
    try {
      await pointAt("r1");
      expect(fieldValue()).toBe("about r1");
      await pointAt("r2");
      expect(fieldValue()).toBe("about r2");
      await pointAt("r1");
      expect(fieldValue()).toBe("about r1");
    } finally {
      vi.unstubAllGlobals();
      dom.window.close();
    }
  });

  it("forgets the text when the server took it, and keeps it when the send failed", async () => {
    const { page } = await openBar({
      feedback: { status: 500, body: { error: { code: "internal", message: "no room", requestId: "q2" } } },
    });
    try {
      await type(page, "send me");
      await press(page);
      await settle();
      await settle();

      // A refused send keeps both the field and the entry, which is what makes a
      // retry possible.
      expect(fieldOf(page).value).toBe("send me");
      expect(page.window.localStorage.getItem("pi-sec:drafts::feedback:r1")).not.toBeNull();
      expect(page.document.getElementById("toast")?.textContent).toContain("no room");
    } finally {
      page.close();
    }

    const accepted = await openBar();
    try {
      await type(accepted.page, "send me");
      await press(accepted.page);
      await settle();
      await settle();
      expect(fieldOf(accepted.page).value).toBe("");
      expect(accepted.page.window.localStorage.getItem("pi-sec:drafts::feedback:r1")).toBeNull();
    } finally {
      accepted.page.close();
    }
  });
});

/* ------------------------------------------------------ a result report */

/**
 * A result report's bar.
 *
 * The same component draws two buttons here: Done closes the result, and Feedback
 * sends what is in the field as a request for more in the same report. Done takes
 * the text too, so the two presses differ in what they do with it and not in
 * whether they read it.
 */
describe("a result report's bar", () => {
  interface ResultOptions {
    readonly done?: { status?: number; body?: unknown };
    readonly approve?: { status?: number; body?: unknown };
  }

  async function openResult(options: ResultOptions = {}): Promise<UiPageHandle> {
    const report = { ...makeReport(), name: "log", title: "Run log", kind: "result", status: "result" };
    const done = options.done;
    const approve = options.approve;
    const fetch: Record<string, FetchAnswer> = {
      "/api/reports/by-name/log": () => ({ body: report }),
      "/api/reports/r1/versions/1": () => ({ text: BODIES["1"] ?? "" }),
      "/api/reports/r1/versions/2": () => ({ text: BODIES["2"] ?? "" }),
      "/api/reports/r1/approve": () => ({ status: approve?.status ?? 201, body: approve?.body ?? {} }),
      "/api/reports/r1/done": () => {
        const status = done?.status ?? 201;
        if (status < 400) report.versions[1]!.approval = { at: 5_000, via: "viewer", sha256: "b", button: "done" };
        return {
          status,
          body: done?.body ?? { id: "r1", version: 2, approval: { at: 5_000, via: "viewer", sha256: "b", button: "done" } },
        };
      },
      "/api/reports/r1/feedback": () => ({ status: 201, body: {} }),
    };
    const page = await loadUiPage("report", { url: "/report/log", fetch });
    await settle();
    await settle();
    return page;
  }

  function doneOf(page: UiPageHandle): HTMLButtonElement {
    return page.document.getElementById("feedback-done") as HTMLButtonElement;
  }

  function feedbackOf(page: UiPageHandle): HTMLButtonElement {
    return page.document.getElementById("feedback-submit") as HTMLButtonElement;
  }

  function click(page: UiPageHandle, element: Element): void {
    element.dispatchEvent(new page.window.Event("click", { bubbles: true }));
  }

  it("draws both buttons, and keeps Feedback off until there is text", async () => {
    const page = await openResult();
    try {
      expect(doneOf(page).textContent).toBe("Done");
      expect(feedbackOf(page).textContent).toBe("Feedback");
      expect(feedbackOf(page).className).toContain("button-feedback");
      expect(doneOf(page).disabled).toBe(false);
      expect(feedbackOf(page).disabled).toBe(true);

      await type(page, "more numbers");
      expect(feedbackOf(page).disabled).toBe(false);
      // Done stays pressable with text, because text with Done is a follow-up
      // request rather than a reason to wait.
      expect(doneOf(page).disabled).toBe(false);

      // Whitespace is not text, so Feedback goes off again and Done stays on.
      await type(page, "   ");
      expect(feedbackOf(page).disabled).toBe(true);
      expect(doneOf(page).disabled).toBe(false);
    } finally {
      page.close();
    }
  });

  it("sends Done, and reads the answer as a Done", async () => {
    const page = await openResult();
    try {
      click(page, doneOf(page));
      await settle();
      await settle();

      expect(posts(page)).toEqual([{ path: "/api/reports/r1/done", body: { version: 2, via: "viewer" } }]);
      // The line under the bar says which button was pressed, from the record.
      expect(hintOf(page).textContent).toContain("Done v2");
      expect(doneOf(page).disabled).toBe(true);
    } finally {
      page.close();
    }
  });

  it("sends the field's text with Done", async () => {
    const page = await openResult();
    try {
      await type(page, "run it on the second machine");
      click(page, doneOf(page));
      await settle();
      await settle();

      expect(posts(page)).toEqual([
        { path: "/api/reports/r1/done", body: { version: 2, via: "viewer", text: "run it on the second machine" } },
      ]);
      // The server took the text, so the field is empty and its draft is gone.
      expect(fieldOf(page).value).toBe("");
      expect(page.window.localStorage.getItem("pi-sec:drafts::feedback:r1")).toBeNull();
    } finally {
      page.close();
    }
  });

  it("keeps the reader's text when the server refuses the Done", async () => {
    const page = await openResult({
      done: { status: 409, body: { error: { code: "not_active", message: "the job finished" } } },
    });
    try {
      await type(page, "run it again");
      click(page, doneOf(page));
      await settle();
      await settle();

      expect(fieldOf(page).value).toBe("run it again");
      expect(fieldOf(page).disabled).toBe(false);
      // The bar is corrected from the refusal, the way any refusal corrects it.
      expect(hintOf(page).textContent).toContain("finished");
    } finally {
      page.close();
    }
  });

  it("turns Done off on an older revision, and names the newest one", async () => {
    const page = await openResult();
    try {
      const select = page.document.querySelector("#version-select") as HTMLSelectElement;
      select.value = "1";
      select.dispatchEvent(new page.window.Event("change"));
      await settle();
      await settle();

      expect(doneOf(page).disabled).toBe(true);
      expect(hintOf(page).textContent).toContain("Only the newest revision");
      // Feedback is about the text, so it follows the field rather than the
      // revision.
      expect(feedbackOf(page).disabled).toBe(true);
      await type(page, "a note about the first run");
      expect(feedbackOf(page).disabled).toBe(false);
      click(page, feedbackOf(page));
      await settle();
      await settle();
      expect(posts(page)).toEqual([
        { path: "/api/reports/r1/feedback", body: { body: "a note about the first run", version: 1 } },
      ]);
    } finally {
      page.close();
    }
  });

  it("redraws the bar from a refusal that carries the Done already recorded", async () => {
    const page = await openResult({
      done: {
        status: 409,
        body: {
          error: { code: "already_approved", message: "this revision is already approved" },
          approval: { at: 4_000, via: "viewer", sha256: "b", button: "done" },
        },
      },
    });
    try {
      click(page, doneOf(page));
      await settle();
      await settle();

      // The answer carries the record the screen did not have, so the bar draws
      // what a report read after that Done would draw.
      expect(doneOf(page).disabled).toBe(true);
      expect(hintOf(page).textContent).toContain("Done v2");
    } finally {
      page.close();
    }
  });

  it("reads a Done that the report already carries", async () => {
    const page = await loadUiPage("report", {
      url: "/report/log",
      fetch: {
        "/api/reports/by-name/log": () => {
          const report = { ...makeReport(), name: "log", title: "Run log", kind: "result", status: "pending" };
          report.versions[1] = { ...report.versions[1]!, approval: { at: 4_000, via: "viewer", sha256: "b", button: "done" } };
          return { body: report };
        },
        "/api/reports/r1/versions/1": () => ({ text: BODIES["1"] ?? "" }),
        "/api/reports/r1/versions/2": () => ({ text: BODIES["2"] ?? "" }),
      },
    });
    try {
      await settle();
      await settle();
      expect(doneOf(page).disabled).toBe(true);
      expect(hintOf(page).textContent).toContain("Done v2");
      expect(posts(page)).toEqual([]);
    } finally {
      page.close();
    }
  });
});
