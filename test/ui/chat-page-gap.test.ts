/**
 * The old chat-panel assertions the assembled-page tests had not carried over.
 *
 * A comparison of every assertion of the hand-written page's tests
 * with the new ones left a list of lines nothing new looked at.
 * This file is the chat-panels part of that list: the
 * three panels of the one left-hand slot, the report panel's shared control, and
 * the page around them. Each test is named after the old test it stands in for,
 * and it looks at the same thing at the same strength: a request count is still a
 * count, a refusal is still read out of the refusal's own fields, and a CSS rule
 * is still the rule the stylesheet carries.
 *
 * One line came from outside that comparison: the login panel read the provider
 * list twice when a login ended, because the header's credential line and the
 * panel's form kept two stores. `src/ui/state/login.ts` now fills both from the
 * one read, and the last test counts the reads.
 *
 * The page is the assembled one (`loadChatPage`): the shell from
 * `src/web/index.html` with the real test bundle in it and the daemon faked, so a
 * test here also says the parts agree with each other.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadUiPage, root, settle, type FetchAnswer, type UiPageHandle } from "./harness.ts";
import {
  byId,
  escape,
  loadChatPage,
  more,
  openLoginPanel,
  openReportPanel,
  openSnippetPanel,
  press,
  providerList,
  reportNotice,
  reportRecord,
  type,
} from "./chat-harness.ts";

let open: UiPageHandle | undefined;

afterEach(() => {
  vi.useRealTimers();
  open?.close();
  open = undefined;
});

/** Keep a page for teardown, and hand it back. */
function keep(ui: UiPageHandle): UiPageHandle {
  open = ui;
  return ui;
}

/** The page a report notice is one press away on, with the report it names. */
async function pageWithReport(options: Parameters<typeof loadChatPage>[0] = {}): Promise<UiPageHandle> {
  return keep(
    await loadChatPage({
      ...options,
      fetch: {
        "/api/reports/r1": { body: reportRecord(2) },
        "/api/reports/r1/versions/2": { text: "# Plan\n\nsecond revision" },
        "/api/inbox": { body: { items: [reportNotice()] } },
        ...(options.fetch ?? {}),
      },
    }),
  );
}

/** The field the shared control writes into, on whichever surface holds it. */
function fieldOf(ui: UiPageHandle): HTMLTextAreaElement {
  return byId<HTMLTextAreaElement>(ui, "feedback-body");
}

/** The control's one button. */
function buttonOf(ui: UiPageHandle): HTMLButtonElement {
  return byId<HTMLButtonElement>(ui, "feedback-submit");
}

/** Press the shared control's own submit, which is the press both surfaces listen for. */
async function submit(ui: UiPageHandle): Promise<void> {
  byId(ui, "report-pane-feedback")
    .querySelector("#feedback-form")!
    .dispatchEvent(new ui.window.Event("submit", { cancelable: true, bubbles: true }));
  await more(4);
}

/** Every entry in the page's `localStorage`, as `key=value`. */
function storedEntries(ui: UiPageHandle): string[] {
  const storage = ui.window.localStorage;
  return Object.keys(storage)
    .sort()
    .map((key) => `${key}=${storage.getItem(key) ?? ""}`);
}

/** The draft entries the page wrote, in full. */
function draftEntries(ui: UiPageHandle): Record<string, string> {
  const found: Record<string, string> = {};
  for (const key of Object.keys(ui.window.localStorage)) {
    if (key.startsWith("pi-sec:drafts:")) found[key] = ui.window.localStorage.getItem(key) ?? "";
  }
  return found;
}

/** The value a stored draft carries, as the app writes it at the root mount. */
function storedText(ui: UiPageHandle, box: string): string {
  const raw = ui.window.localStorage.getItem(`pi-sec:drafts::${box}`) ?? "null";
  return String((JSON.parse(raw) as { text?: unknown } | null)?.text ?? "");
}

/* ------------------------------------------------------------ the login fixtures */

/** One login that answers a prompt and then ends as signed in. */
const LOGIN_ROUTES: Readonly<Record<string, FetchAnswer>> = {
  "/api/admin/model-login/providers": { body: providerList() },
  "/api/admin/model-login/start": {
    body: {
      session: "session-1",
      state: {
        status: "prompt",
        provider: "anthropic",
        type: "oauth",
        prompt: { type: "manual_code", message: "Paste the code the provider showed", placeholder: "code#state" },
        events: [{ type: "auth_url", url: "https://signin.example.test/authorize", instructions: "Open the link." }],
        startedAt: "2026-10-24T00:00:00.000Z",
        finishedAt: null,
        loginAt: null,
        reason: null,
        warning: null,
      },
    },
  },
  "/api/admin/model-login/answer": {
    body: {
      status: "succeeded",
      provider: "anthropic",
      type: "oauth",
      prompt: null,
      events: [],
      startedAt: "2026-10-24T00:00:00.000Z",
      finishedAt: "2026-10-24T00:05:00.000Z",
      loginAt: "2026-10-24T00:05:00.000Z",
      reason: null,
      warning: null,
    },
  },
};

/* ------------------------------------------------------------------ drafts */

describe("the text the page keeps in the browser", () => {
  it("keeps the snippet body and the login code out of the store", async () => {
    const ui = keep(await loadChatPage({ fetch: LOGIN_ROUTES }));

    // The two fields that hold credential material: a snippet's body, and the
    // code a provider asked for. Both are the operator's while they are typed.
    await openSnippetPanel(ui);
    type(ui, byId(ui, "snippet-body"), "SECRET-SNIPPET-BODY");
    await more(2);

    await openLoginPanel(ui);
    vi.useFakeTimers();
    press(ui, byId(ui, "login-start"));
    await vi.advanceTimersByTimeAsync(0);
    const answer = ui.document.getElementById("login-answer");
    expect(answer, "the login panel draws no answer field, so nothing was typed into it").not.toBeNull();
    type(ui, answer as HTMLElement, "SECRET-LOGIN-CODE");
    await vi.advanceTimersByTimeAsync(0);
    vi.useRealTimers();

    const all = storedEntries(ui).join("\n");
    expect(all).not.toContain("SECRET-SNIPPET-BODY");
    expect(all).not.toContain("SECRET-LOGIN-CODE");
    // Not even an empty entry: the store holds what the two boxes keep, and these
    // are not boxes it keeps.
    expect(draftEntries(ui)).toEqual({});
  });

  it("is one entry for the viewer and the chat's report panel", async () => {
    // The viewer writes the text, and its entry is the one the panel reads.
    const viewer = await loadUiPage("report", {
      url: "/report/plan",
      fetch: {
        "/api/reports/by-name/plan": { body: reportRecord(2, { name: "plan", title: "Plan" }) },
        "/api/reports/r1/versions/2": { text: "# Plan\n\nsecond revision" },
      },
    });
    await more(2);
    const viewerField = viewer.document.getElementById("feedback-body") as HTMLTextAreaElement;
    viewerField.value = "shared words";
    viewerField.dispatchEvent(new viewer.window.Event("input", { bubbles: true }));
    await more(2);
    const written = viewer.window.localStorage.getItem("pi-sec:drafts::feedback:r1");
    expect(written).not.toBeNull();
    expect(JSON.parse(written ?? "{}")).toMatchObject({ text: "shared words" });
    viewer.close();

    // The chat page of the same browser reads that entry, and writes it back.
    const ui = await pageWithReport();
    ui.window.localStorage.setItem("pi-sec:drafts::feedback:r1", written ?? "");
    await openReportPanel(ui);

    expect(fieldOf(ui).value).toBe("shared words");
    // Restored text is text, so the one button is the one that sends it.
    expect(buttonOf(ui).textContent).toBe("Feedback");

    type(ui, fieldOf(ui), "typed in the panel");
    await more(2);
    expect(storedText(ui, "feedback:r1")).toBe("typed in the panel");
  });

  it("brings each report's text back when the panel switches between them", async () => {
    const ui = keep(
      await loadChatPage({
        fetch: {
          "/api/inbox": {
            body: {
              items: [
                reportNotice("r1", { id: "i1", title: "Report published: Plan one" }),
                reportNotice("r2", { id: "i2", title: "Report published: Plan two" }),
              ],
            },
          },
          "/api/reports/r1": { body: reportRecord(2, { id: "r1", name: "plan", title: "Plan one" }) },
          "/api/reports/r1/versions/2": { text: "one" },
          "/api/reports/r2": { body: reportRecord(2, { id: "r2", name: "other", title: "Plan two" }) },
          "/api/reports/r2/versions/2": { text: "two" },
        },
      }),
    );

    await openReportPanel(ui, 0);
    type(ui, fieldOf(ui), "about one");
    await more(2);

    await openReportPanel(ui, 1);
    expect(fieldOf(ui).value).toBe("");
    type(ui, fieldOf(ui), "about two");
    await more(2);

    await openReportPanel(ui, 0);
    expect(fieldOf(ui).value).toBe("about one");
    expect(storedText(ui, "feedback:r1")).toBe("about one");
    expect(storedText(ui, "feedback:r2")).toBe("about two");
  });
});

/* ---------------------------------------------------------- a focused chat */

/** One focused chat's record, as the read route answers it. */
function chatRecord(id: number, title: string, test = false): Record<string, unknown> {
  return { conversationId: id, name: `chat-${id}`, title, openedAt: 1_000, archived: false, archivedAt: null, test };
}

/** Load the chat page at one chat's own address, from that chat's own record. */
async function loadFocused(id: number, title: string, test = false): Promise<UiPageHandle> {
  const ui = await loadChatPage({
    url: `/basic-chat?chat=${id}`,
    fetch: { [`/api/focused-chats/${id}`]: { body: chatRecord(id, title, test) } },
  });
  await more(2);
  return ui;
}

/**
 * One chat's identity taken out of a page's text.
 *
 * Two chats are different conversations, so their numbers differ by construction.
 * Everything else about them is the same, which is what the comparison below is
 * about. The title is swapped too, because that is the one thing a page is meant
 * to say differently.
 */
function swap(text: string, chat: { readonly id: number; readonly title: string }): string {
  return text
    .replaceAll(chat.title, "{{title}}")
    .replace(new RegExp(`chat=${chat.id}(?![\\d-])`, "g"), "chat={{chatId}}")
    .replace(new RegExp(`/api/conversations/${chat.id}(?![\\d-])`, "g"), "/api/conversations/{{chatId}}")
    .replace(new RegExp(`/api/focused-chats/${chat.id}(?![\\d-])`, "g"), "/api/focused-chats/{{chatId}}");
}

/** The word a reader would take as the mark, on its own somewhere. */
const TEST_WORD = /(^|[^a-z0-9])test([^a-z0-9]|$)/i;

/** Everything on the page that would tell a reader this chat is a test. */
function testMarks(ui: UiPageHandle): string[] {
  const found: string[] = [];
  for (const element of ui.document.querySelectorAll("*")) {
    if (TEST_WORD.test(element.id)) found.push(`id "${element.id}"`);
    for (const name of element.classList) if (TEST_WORD.test(name)) found.push(`class "${name}"`);
    for (const attribute of element.attributes) {
      if (!attribute.name.startsWith("data-")) continue;
      if (TEST_WORD.test(attribute.name)) found.push(`attribute "${attribute.name}"`);
      else if (TEST_WORD.test(attribute.value)) found.push(`attribute ${attribute.name}="${attribute.value}"`);
    }
  }
  // One text node at a time: two words side by side are not one word, and a
  // joined body's text would invent matches across element boundaries.
  const walker = ui.document.createTreeWalker(ui.document.body, ui.window.NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    const text = node.textContent ?? "";
    if (TEST_WORD.test(text)) found.push(`text "${text.trim()}"`);
  }
  return found;
}

describe("a focused chat's bar", () => {
  const TITLE = "Same topic, twice";

  it("is served as the same page, whatever chat the address names", async () => {
    // The page a chat address gets is one shell: the server stamps the mount, the
    // zone and the registered name into it, and the chat's number is read off the
    // address in the browser, so two chats cannot change the bytes the server
    // sends. A chat id or a title written into the shell would change that.
    const shell = await readFile(join(root, "src/web/index.html"), "utf8");
    expect(shell).not.toMatch(/\{\{\s*chat/i);
    expect(shell).not.toMatch(/data-chat-id|data-conversation-id/);

    // And the two addresses draw one page: the same elements, with the same ids,
    // in the same order, and nothing in the bar that the other chat does not have.
    const one = await loadFocused(7, TITLE);
    const idsOf = (ui: UiPageHandle): string[] => [...ui.document.querySelectorAll("[id]")].map((element) => element.id);
    const first = idsOf(one);
    const title = one.window.document.title;
    one.close();

    const two = keep(await loadFocused(8, TITLE));
    expect(idsOf(two)).toEqual(first);
    expect(two.window.document.title).toBe(title);
    expect(byId(two, "chat-title").textContent).toBe(TITLE);
  });

  it("draws the same bar and the same markup from each chat's own answer", async () => {
    const one = await loadFocused(7, TITLE);
    // Each page read its own chat and no other's.
    expect(one.fetchCalls.filter((call) => call.path.startsWith("/api/focused-chats/")).map((call) => call.path)).toEqual([
      "/api/focused-chats/7",
    ]);
    const header = (ui: UiPageHandle): string =>
      (ui.document.querySelector("header.app-header") as HTMLElement).outerHTML;
    const headerOne = header(one);
    const bodyOne = one.document.body.innerHTML;
    one.close();

    const two = keep(await loadFocused(8, TITLE));
    expect(two.fetchCalls.filter((call) => call.path.startsWith("/api/focused-chats/")).map((call) => call.path)).toEqual([
      "/api/focused-chats/8",
    ]);

    expect(swap(header(two), { id: 8, title: TITLE })).toBe(swap(headerOne, { id: 7, title: TITLE }));
    expect(swap(two.document.body.innerHTML, { id: 8, title: TITLE })).toBe(swap(bodyOne, { id: 7, title: TITLE }));

    // Both say the same thing about the chat, and light the same mark.
    expect(byId(two, "chat-title").textContent).toBe(TITLE);
    expect(two.document.body.dataset.chat).toBe("focused");
    expect(two.window.document.title).toBe(`${TITLE} · pi-sec`);
  });

  it("marks nothing on the page as a test", async () => {
    const plain = await loadFocused(8, TITLE);
    expect(testMarks(plain)).toEqual([]);
    plain.close();

    const ui = keep(await loadFocused(7, TITLE, true));
    expect(testMarks(ui)).toEqual([]);
    // The checker can see a mark that is there, so the empty answer above is
    // "nothing to find" rather than "nothing was looked at".
    const probe = ui.document.createElement("span");
    probe.className = "chat-test-mark";
    probe.setAttribute("data-test", "true");
    probe.textContent = "test chat";
    ui.document.body.append(probe);
    expect(testMarks(ui).length).toBeGreaterThanOrEqual(3);
    probe.remove();
    expect(testMarks(ui)).toEqual([]);
  });

  it("puts the π mark first in the bar and the work-panel press last, and the press still works", async () => {
    const ui = keep(await loadChatPage());
    const header = ui.document.querySelector("header.app-header") as HTMLElement;

    // The left block opens with the mark the companion pages carry beside their
    // own name, and it is not a press.
    const left = header.firstElementChild as HTMLElement;
    expect(left.className).toContain("header-left");
    const mark = left.querySelector(".brand-mark") as HTMLElement;
    expect(mark.textContent).toBe("π");
    expect(mark.getAttribute("aria-hidden")).toBe("true");
    expect(mark.closest("button, a")).toBeNull();

    // The toggle is the last thing in the bar, so the press sits at the edge the
    // work panel opens from.
    expect(header.lastElementChild?.id).toBe("sidebar-toggle");
    expect(byId(ui, "sidebar-toggle").getAttribute("aria-label")).toBe("Toggle the work panel");

    press(ui, byId(ui, "sidebar-toggle"));
    await more(2);
    expect(ui.document.body.dataset.sidebar).toBe("closed");
    expect(byId(ui, "sidebar-toggle").getAttribute("aria-expanded")).toBe("false");

    press(ui, byId(ui, "sidebar-toggle"));
    await more(2);
    expect(ui.document.body.dataset.sidebar).toBe("open");
    expect(byId(ui, "sidebar-toggle").getAttribute("aria-expanded")).toBe("true");
  });

  it("keeps the whole of a long title in the element, and lets the bar shorten it", async () => {
    const long = "A long conversation about the release checklist and the two builds behind it";
    const ui = keep(await loadFocused(7, long));

    const title = byId(ui, "chat-title");
    expect(title.textContent).toBe(long);
    expect(title.getAttribute("title")).toBe(long);

    // The shortening is the stylesheet's job: one line, cut with an ellipsis.
    const css = (await readFile(join(root, "src/web/styles.css"), "utf8")).replace(/\/\*[\s\S]*?\*\//g, "");
    const rule = /\.chat-title\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";
    expect(rule).toContain("text-overflow: ellipsis");
    expect(rule).toMatch(/overflow:\s*hidden/);
    expect(rule).toMatch(/white-space:\s*nowrap/);
  });

  it("gives a focused chat's bar a fill of its own, in both themes", async () => {
    const styles = await readFile(join(root, "src/web/styles.css"), "utf8");
    const theme = await readFile(join(root, "src/web/theme.css"), "utf8");

    // A class the page sets on a high-level element, and the fill it points at.
    expect(styles).toMatch(/body\[data-chat="focused"\]\s+\.app-header\s*\{[^}]*background:\s*var\(--chat-header-bg\)/);
    // Two values, so the bar is not the same colour as the page behind it in one
    // theme and invisible in the other.
    const light = /:root\s*\{[^}]*--chat-header-bg:\s*([^;]+);/.exec(theme)?.[1];
    const dark = /\[data-theme="dark"\]\s*\{[^}]*--chat-header-bg:\s*([^;]+);/.exec(theme)?.[1];
    const auto = /@media \(prefers-color-scheme: dark\)\s*\{\s*\[data-theme="auto"\]\s*\{[^}]*--chat-header-bg:\s*([^;]+);/.exec(
      theme,
    )?.[1];
    expect(light).toBeDefined();
    expect(dark).toBeDefined();
    expect(auto).toBeDefined();
    expect(light).not.toBe(dark);
  });
});

/* ------------------------------------------------------------- the one slot */

describe("the one panel slot", () => {
  it("never stands open beside the report panel, in either direction", async () => {
    const ui = await pageWithReport();
    const body = ui.document.body;

    // A report is open; the snippet button takes the slot it was in.
    await openReportPanel(ui);
    expect(body.dataset.report).toBe("open");
    await openSnippetPanel(ui);
    expect(body.dataset.snippet).toBe("open");
    expect(body.dataset.report).toBe("closed");

    // And a report opened while the snippet panel is up closes the panel.
    await openReportPanel(ui);
    expect(body.dataset.report).toBe("open");
    expect(body.dataset.snippet).toBe("closed");
    expect(byId(ui, "report-pane-title").textContent).toBe("Plan");
  });
});

/* ------------------------------------------------------- the panel's control */

describe("the report panel's control", () => {
  it("sends what is typed as feedback, through the panel and the same route", async () => {
    const ui = await pageWithReport();
    await openReportPanel(ui);

    type(ui, fieldOf(ui), "please change this part");
    await more(2);
    // Text in the field turns the one button into the send button, in words.
    expect(buttonOf(ui).textContent).toBe("Feedback");
    await submit(ui);

    const sent = ui.fetchCalls.find((call) => call.path === "/api/reports/r1/feedback");
    expect(sent?.method).toBe("POST");
    expect(JSON.parse(sent?.body ?? "null")).toEqual({ body: "please change this part", version: 2 });
    // The note is written into the chat, so the panel steps aside for it.
    expect(ui.document.body.dataset.report).toBe("closed");
    expect(fieldOf(ui).value).toBe("");
    expect(buttonOf(ui).textContent).toBe("Approve");

    // Opened again, the control is where the press left it: nothing typed, and
    // the newest revision still unapproved.
    await openReportPanel(ui);
    expect(fieldOf(ui).value).toBe("");
    expect(buttonOf(ui).textContent).toBe("Approve");
  });

  it("says why the server refused an approval, from the refusal's own fields", async () => {
    // The panel is opened while the page's own read says v2, and the press is
    // refused by a server whose newest revision is v3.
    const ui = await pageWithReport({
      fetch: {
        "/api/reports/r1/approve": {
          status: 409,
          body: {
            error: { code: "stale_revision", message: "only the newest revision can be approved, and that is v3" },
            latest: 3,
          },
        },
      },
    });
    await openReportPanel(ui);

    await submit(ui);

    // The reason comes out of the refusal's own fields, not out of the wording of
    // its message: the code names the refusal and `latest` names the revision.
    expect(byId(ui, "feedback-hint").textContent).toContain("Only the newest revision can be approved.");
    expect(byId(ui, "feedback-hint").textContent).not.toContain("only the newest revision can be approved, and that is v3");
    expect(buttonOf(ui).disabled).toBe(true);
    // The refusal is what the panel is showing, so the panel stays where it is.
    expect(ui.document.body.dataset.report).toBe("open");
  });

  it("closes the panel from its button and on Escape", async () => {
    const ui = await pageWithReport();
    await openReportPanel(ui);
    expect(ui.document.body.dataset.report).toBe("open");

    press(ui, byId(ui, "report-pane-close"));
    await more(2);
    expect(ui.document.body.dataset.report).toBe("closed");
    expect(byId(ui, "report-pane-title").textContent).toBe("Report");

    await openReportPanel(ui);
    expect(ui.document.body.dataset.report).toBe("open");
    escape(ui);
    await more(2);
    expect(ui.document.body.dataset.report).toBe("closed");
  });

  it("keeps the control on screen when the panel is closed and opened again", async () => {
    const ui = await pageWithReport();
    await openReportPanel(ui);
    expect(byId(ui, "report-pane-feedback").hasAttribute("hidden")).toBe(false);

    // The close button takes the panel off the screen; the notice re-opens it.
    press(ui, byId(ui, "report-pane-close"));
    await more(2);
    expect(ui.document.body.dataset.report).toBe("closed");
    await openReportPanel(ui);

    expect(ui.document.body.dataset.report).toBe("open");
    const control = byId(ui, "report-pane-feedback");
    expect(control.hasAttribute("hidden")).toBe(false);
    // ...and it is a control the operator can press, not an empty box.
    expect(control.querySelector("#feedback-form")).not.toBeNull();
    expect(buttonOf(ui).textContent).toBe("Approve");
    expect(buttonOf(ui).disabled).toBe(false);
  });

  it("closes the panel on a sent approval, and a later report_updated does not reopen it", async () => {
    const ui = await pageWithReport();
    await openReportPanel(ui);
    const reads = (): number => ui.fetchCalls.filter((call) => call.path === "/api/reports/r1").length;
    expect(reads()).toBe(1);

    // The press closes the panel. It is not read again for it: the record the
    // panel would show is the one the chat now carries.
    await submit(ui);
    expect(ui.document.body.dataset.report).toBe("closed");
    expect(reads()).toBe(1);

    // A closed panel does not follow a change to the report it last showed.
    ui.respond("/api/reports/r1", { body: reportRecord(3) });
    ui.respond("/api/reports/r1/versions/3", { text: "third revision" });
    ui.emit("report_updated", { id: "r1" });
    await more(4);

    expect(ui.document.body.dataset.report).toBe("closed");
    expect(reads()).toBe(1);
  });

  it("does not reopen the panel when a load is in flight as the panel closes", async () => {
    const ui = await pageWithReport();
    await openReportPanel(ui);
    expect(ui.document.body.dataset.report).toBe("open");

    // A re-read is started and not waited for: the frame opens the panel and then
    // waits for the record. The press lands while that read is still out, so the
    // answer is owed to a panel that no longer exists by the time it comes back.
    let release: ((answer: { status?: number; body?: unknown }) => void) | undefined;
    ui.respond("/api/reports/r1", () => new Promise((resolve) => (release = resolve)));
    ui.emit("report_updated", { id: "r1" });
    await more(2);
    press(ui, byId(ui, "report-pane-close"));
    await more(2);
    expect(ui.document.body.dataset.report).toBe("closed");

    release?.({ body: reportRecord(3) });
    await more(4);

    // The load must fail its own guard instead of putting the panel back on the
    // screen: the close is the operator's last word, not a delay.
    expect(ui.document.body.dataset.report).toBe("closed");
    expect(byId(ui, "report-pane-feedback").hasAttribute("hidden")).toBe(true);
  });

  it("takes the focus out of the panel when it closes", async () => {
    const ui = await pageWithReport();
    await openReportPanel(ui);
    type(ui, fieldOf(ui), "please change this part");
    fieldOf(ui).focus();
    // The name of this test is only worth its assertion if the focus is really in
    // the panel first: a field that never took it leaves nothing to take away.
    expect(ui.document.activeElement).toBe(fieldOf(ui));

    await submit(ui);

    expect(ui.document.body.dataset.report).toBe("closed");
    // A focused field on a panel that is off the screen keeps taking what the
    // operator types, so the close hands the focus back.
    expect(byId(ui, "report-pane-feedback").contains(ui.document.activeElement)).toBe(false);
  });
});

/* ------------------------------------------------------- the page around them */

describe("the page around the panels", () => {
  it("stacks the panel's control on a narrow screen", async () => {
    const css = await readFile(join(root, "src/web/styles.css"), "utf8");
    const blocks = [...css.matchAll(/@media \(max-width: 860px\) \{[\s\S]*?\n\}/g)].map((match) => match[0]);
    const panel = blocks.filter((block) => block.includes(".report-pane-feedback"));

    expect(panel).toHaveLength(1);
    expect(panel[0]).toContain(".report-pane-feedback .report-feedback-form button");
    expect(panel[0]).toContain("width: 100%");
    expect(panel[0]).toContain("min-height: 44px");
    // The container is styled by the page, the form by the shared component.
    expect(css).toContain(".report-pane-feedback {");
    expect(css).toContain(".report-pane-feedback .feedback-hint");
  });

  it("keeps the theme control inside the sidebar", async () => {
    const ui = keep(await loadChatPage());
    const theme = byId(ui, "theme-toggle");
    expect(byId(ui, "sidebar").contains(theme)).toBe(true);
    expect(theme.textContent).toContain("auto");

    press(ui, theme);
    await more(2);
    expect(ui.document.documentElement.dataset.theme).toBe("light");
    expect(byId(ui, "theme-toggle").textContent).toContain("light");
  });

  it("stacks the panels in the order the operator reads them", async () => {
    const ui = keep(await loadChatPage());
    const sidebar = byId(ui, "sidebar");
    // DOM order is the drawn order: the sidebar is a column and no rule reorders
    // it. This order is the rule, so a later edit that reverses it
    // without meaning to is caught here.
    const titles = [...sidebar.querySelectorAll("section.panel > h2")].map((heading) =>
      (heading.textContent ?? "").trim().replace(/\s+/g, " "),
    );
    expect(titles).toHaveLength(5);
    expect(titles[0]).toBe("Awaiting you");
    expect(titles[1]).toMatch(/^Inbox\b/);
    // The diagnostic notes keep their place right after the inbox.
    expect(titles[2]).toBe("Notes");
    expect(titles[3]).toBe("Jobs");
    // The remote machines come last, below the job tree.
    expect(titles[4]).toBe("Machines");
    // The footer stays the foot: it is not one of the panels and never moves.
    expect(sidebar.lastElementChild?.classList.contains("sidebar-footer")).toBe(true);
  });

  it("loads the card script right after base.js", async () => {
    const html = await readFile(join(root, "src/web/index.html"), "utf8");
    const scripts = [...html.matchAll(/<script src="\{\{base\}\}\/([^"]+)"><\/script>/g)].map((each) => each[1]);
    expect(scripts.slice(0, 2)).toEqual(["base.js", "ui-cards.js"]);
  });

  it("is the page's only way to the chat list, since the inbox heading carries no link", async () => {
    const ui = keep(await loadChatPage());

    // The heading holds the count and `hide all` and nothing that leaves the
    // page: the row below is where the chat list is opened from.
    const heading = byId(ui, "inbox-count").closest("h2") as HTMLElement;
    expect(heading.textContent).toContain("Inbox");
    expect(heading.textContent).toContain("hide all");
    expect(heading.querySelector("a")).toBeNull();
    expect(ui.document.getElementById("chats-link")).toBeNull();

    press(ui, byId(ui, "pages-toggle"));
    await more(2);
    const chats = [...ui.document.querySelectorAll("#pages-menu a")].find((each) => each.textContent === "Chats");
    expect(chats?.getAttribute("href")).toBe("/chats");
  });
});

/* ----------------------------------------------------------- one read, not two */

describe("the login panel's reads", () => {
  it("reads the provider list once when a login ends", async () => {
    const ui = keep(await loadChatPage({ fetch: LOGIN_ROUTES }));
    const reads = (): number =>
      ui.fetchCalls.filter((call) => call.path === "/api/admin/model-login/providers").length;

    await openLoginPanel(ui);
    const opened = reads();
    expect(opened).toBeGreaterThan(0);

    // A login that ends is two facts: the credential exists now, and this
    // provider's recorded login time moved. The header's line and this form read
    // both, and one read of the route answers both.
    vi.useFakeTimers();
    press(ui, byId(ui, "login-start"));
    await vi.advanceTimersByTimeAsync(0);
    const answer = ui.document.getElementById("login-answer") as HTMLInputElement;
    answer.value = "test-code-0001";
    press(ui, byId(ui, "login-answer-submit"));
    await vi.advanceTimersByTimeAsync(10);
    vi.useRealTimers();

    expect(byId(ui, "login-status").textContent).toContain("Signed in");
    expect(reads()).toBe(opened + 1);
  });
});
