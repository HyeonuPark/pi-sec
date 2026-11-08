/**
 * The model login panel, on the assembled chat page.
 *
 * The whole feature is this: two selects, `Start login`, `Cancel`, a
 * stream of what the provider said (a sign-in link, a device code, a line of
 * progress), the question it is waiting on — as a field or as a list of choices —
 * and a state read once a second.
 *
 * The daemon is a stub here: `POST .../start` answers a prompt, `.../state`
 * answers whatever the test last set, and `.../answer` records what was sent. The
 * three things that are pinned hardest are the ones a login can leak: the session
 * id never goes in a URL, nothing typed is kept anywhere but in the field, and a
 * refusal is the page's fixed sentence and not the daemon's.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { UiPageHandle } from "./harness.ts";
import { byId, escape, loadChatPage, more, openLoginPanel, press, providerList, type } from "./chat-harness.ts";

const AUTH_URL = "https://signin.example.test/oauth/authorize?code_challenge=AUTH-URL-MARKER-0003";
const CODE = "test-code-0001#test-state-0002";

interface Scenario {
  providers: Record<string, unknown>;
  state: Record<string, unknown> | null;
  answers: string[];
}

let open: UiPageHandle | undefined;
let scenario: Scenario;

afterEach(() => {
  vi.useRealTimers();
  open?.close();
  open = undefined;
});

/** The answers the four login routes give: one login, following the test's scenario. */
const LOGIN_ROUTES = {
  "/api/admin/model-login/start": () => {
    scenario.state = {
      status: "prompt",
      provider: "anthropic",
      type: "oauth",
      prompt: { type: "manual_code", message: "Paste the code the provider showed", placeholder: "code#state" },
      events: [{ type: "auth_url", url: AUTH_URL, instructions: "Open the link, then paste the code." }],
      startedAt: "2026-10-24T00:00:00.000Z",
      finishedAt: null,
      loginAt: null,
      reason: null,
      warning: null,
    };
    return { status: 200, body: { session: "session-1", state: scenario.state } };
  },
  "/api/admin/model-login/state": () => ({ status: 200, body: scenario.state }),
  "/api/admin/model-login/answer": (request: { readonly body: string | null }) => {
    const parsed = JSON.parse(request.body ?? "{}") as { value?: string };
    scenario.answers.push(String(parsed.value));
    scenario.state = {
      ...(scenario.state ?? {}),
      status: "succeeded",
      prompt: null,
      loginAt: "2026-10-24T00:05:00.000Z",
      finishedAt: "2026-10-24T00:05:00.000Z",
    };
    return { status: 200, body: scenario.state };
  },
  "/api/admin/model-login/cancel": () => ({ status: 200, body: { ...(scenario.state ?? {}), status: "cancelled" } }),
};

/** Load the page with the login routes answered from {@link scenario}. */
async function page(over: Record<string, unknown> = {}): Promise<UiPageHandle> {
  scenario = { providers: providerList(), state: null, answers: [], ...over };
  open = await loadChatPage({
    fetch: {
      "/api/admin/model-login/providers": () => ({ status: 200, body: scenario.providers }),
      ...Object.fromEntries(Object.entries(LOGIN_ROUTES).map(([path, answer]) => [path, answer])),
    },
  });
  return open;
}

/** Advance the page's clock, and let what the timers started answer. */
async function advance(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
}

/** Press the panel's controls with the timers under the test's control. */
function fakeClock(): void {
  vi.useFakeTimers();
}

describe("the login panel's form", () => {
  it("opens from the `⋯` menu and lists the providers the daemon offers", async () => {
    const ui = await page();
    expect(ui.document.body.dataset.login).toBe("closed");
    const item = byId(ui, "model-login");
    expect(item.textContent).toBe("Model login");
    expect(byId(ui, "composer-menu").contains(item)).toBe(true);

    await openLoginPanel(ui);
    expect(ui.document.body.dataset.login).toBe("open");
    const providers = byId<HTMLSelectElement>(ui, "login-provider");
    expect([...providers.options].map((option) => option.value)).toEqual(["anthropic", "acme"]);
    // The root model's provider is the one the form starts on.
    expect(providers.value).toBe("anthropic");
    expect([...providers.options].map((option) => option.textContent)).toEqual([
      "anthropic (no credential)",
      "acme [acme]",
    ]);
    expect([...byId<HTMLSelectElement>(ui, "login-type").options].map((option) => option.value)).toEqual([
      "oauth",
      "api_key",
    ]);
    expect(byId(ui, "login-intro").textContent).toBe("Choose a provider and how to sign in.");
    expect(byId(ui, "login-provider-note").textContent).toBe("");
    expect(byId(ui, "login-start").classList.contains("hidden")).toBe(false);
    expect(byId(ui, "login-cancel").classList.contains("hidden")).toBe(true);
  });

  it("says which provider signed in last, and when, in the harness's zone", async () => {
    const ui = await page({
      providers: providerList({
        providers: [
          {
            id: "anthropic",
            extension: null,
            configured: true,
            types: ["oauth"],
            lastLogin: { at: "2026-10-01T00:05:00.000Z", type: "oauth" },
          },
        ],
      }),
    });
    await openLoginPanel(ui);
    // 00:05 UTC is 09:05 in Asia/Tokyo, which is the zone the page was served in.
    expect(byId(ui, "login-provider-note").textContent).toBe("Signed in 2026-10-01 09:05 Asia/Tokyo (OAuth).");
  });

  it("says so when the daemon cannot sign anything in, and holds the button", async () => {
    const ui = await page({ providers: { available: false, providers: [] } });
    await openLoginPanel(ui);
    expect(byId(ui, "login-intro").textContent).toBe("This daemon cannot sign a model provider in.");
    expect(byId<HTMLButtonElement>(ui, "login-start").disabled).toBe(true);
    expect(byId<HTMLSelectElement>(ui, "login-provider").disabled).toBe(true);
  });

  it("opens from the header's credential line too", async () => {
    const ui = await page();
    const banner = byId(ui, "credential-banner");
    expect(banner.classList.contains("hidden")).toBe(false);
    press(ui, banner);
    await more(4);
    expect(ui.document.body.dataset.login).toBe("open");
  });

  it("closes from its own button and on Escape", async () => {
    const ui = await page();
    await openLoginPanel(ui);
    press(ui, byId(ui, "login-pane-close"));
    await more(2);
    expect(ui.document.body.dataset.login).toBe("closed");

    await openLoginPanel(ui);
    escape(ui);
    await more(2);
    expect(ui.document.body.dataset.login).toBe("closed");
  });
});

describe("a login under way", () => {
  it("starts a login, shows the sign-in link, and sends the answer", async () => {
    const ui = await page();
    await openLoginPanel(ui);
    fakeClock();

    press(ui, byId(ui, "login-start"));
    await advance(0);

    const start = ui.fetchCalls.find((call) => call.path === "/api/admin/model-login/start");
    expect(start?.method).toBe("POST");
    expect(JSON.parse(start?.body ?? "null")).toEqual({ provider: "anthropic", type: "oauth" });
    // The session id never travels in a URL: the access log records those.
    for (const call of ui.fetchCalls) expect(call.url).not.toContain("session-1");

    // The sign-in link opens in a new tab, and nothing else is reachable from it.
    const link = ui.document.querySelector("#login-events a") as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe(AUTH_URL);
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
    expect(byId(ui, "login-events").textContent).toContain("Open the link, then paste the code.");

    // The code question is a text field with the provider's placeholder.
    const field = byId<HTMLInputElement>(ui, "login-answer");
    expect(field.type).toBe("text");
    expect(field.placeholder).toBe("code#state");
    expect(field.getAttribute("aria-label")).toBe("Paste the code the provider showed");
    expect(byId(ui, "login-status").textContent).toBe("Waiting for your answer.");
    // While a login runs, Start makes room for Cancel.
    expect(byId(ui, "login-start").classList.contains("hidden")).toBe(true);
    expect(byId(ui, "login-cancel").classList.contains("hidden")).toBe(false);

    field.value = CODE;
    press(ui, byId(ui, "login-answer-submit"));
    await advance(0);

    const answer = ui.fetchCalls.find((call) => call.path === "/api/admin/model-login/answer");
    expect(JSON.parse(answer?.body ?? "null")).toEqual({ session: "session-1", value: CODE });
    expect(scenario.answers).toEqual([CODE]);
    // The field is gone with the question, and the outcome is on screen.
    expect(ui.document.getElementById("login-answer")).toBeNull();
    expect(byId(ui, "login-status").textContent).toBe("Signed in: 2026-10-24 09:05 Asia/Tokyo.");
    expect(byId(ui, "login-start").classList.contains("hidden")).toBe(false);

    // Nothing typed here is kept by the page.
    const stored = Object.keys(ui.window.localStorage).map((key) => `${key}=${ui.window.localStorage.getItem(key)}`);
    for (const entry of stored) {
      expect(entry).not.toContain(CODE);
      expect(entry).not.toContain("session-1");
    }
  });

  it("draws a device code the way the provider asks for it", async () => {
    const ui = await page();
    await openLoginPanel(ui);
    fakeClock();
    press(ui, byId(ui, "login-start"));
    await advance(0);
    scenario.state = {
      status: "running",
      provider: "anthropic",
      type: "oauth",
      prompt: null,
      events: [
        {
          type: "device_code",
          userCode: "ABCD-1234",
          verificationUri: "https://signin.example.test/device",
          intervalSeconds: 5,
        },
        { type: "info", message: "Waiting for the browser.", links: [{ url: "https://example.test/help", label: "Help" }] },
        { type: "progress", message: "Polling the provider…" },
      ],
      startedAt: "2026-10-24T00:00:00.000Z",
      finishedAt: null,
      loginAt: null,
      reason: null,
      warning: null,
    };
    await advance(1000);

    const events = byId(ui, "login-events");
    expect(events.querySelector("code.login-code")?.textContent).toBe("ABCD-1234");
    expect(events.textContent).toContain("Enter this code on the provider's page:");
    const links = [...events.querySelectorAll("a")].map((anchor) => [anchor.textContent, anchor.getAttribute("href")]);
    expect(links).toEqual([
      ["https://signin.example.test/device", "https://signin.example.test/device"],
      ["Help", "https://example.test/help"],
    ]);
    expect(events.textContent).toContain("Polling the provider…");
    expect(byId(ui, "login-status").textContent).toBe("Waiting for anthropic (OAuth)…");
  });

  it("answers a choice list with the option the operator pressed", async () => {
    const ui = await page();
    await openLoginPanel(ui);
    fakeClock();
    press(ui, byId(ui, "login-start"));
    await advance(0);
    scenario.state = {
      status: "prompt",
      provider: "anthropic",
      type: "oauth",
      prompt: {
        type: "select",
        message: "Which account?",
        options: [
          { id: "work", label: "Work account", description: "the paid one" },
          { id: "home", label: "Home account" },
        ],
      },
      events: [],
      startedAt: "2026-10-24T00:00:00.000Z",
      finishedAt: null,
      loginAt: null,
      reason: null,
      warning: null,
    };
    await advance(1000);

    const buttons = [...ui.document.querySelectorAll("#login-prompt .login-options button")];
    expect(buttons.map((button) => button.textContent)).toEqual(["Work account", "Home account"]);
    expect(buttons[0]?.getAttribute("data-option")).toBe("work");
    expect(buttons[0]?.getAttribute("title")).toBe("the paid one");
    press(ui, buttons[1] as Element);
    await advance(0);
    const answer = ui.fetchCalls.filter((call) => call.path === "/api/admin/model-login/answer").at(-1);
    expect(JSON.parse(answer?.body ?? "null")).toEqual({ session: "session-1", value: "home" });
  });

  it("draws a failure as a short reason, and puts Start back", async () => {
    const ui = await page();
    await openLoginPanel(ui);
    fakeClock();
    press(ui, byId(ui, "login-start"));
    await advance(0);

    scenario.state = {
      ...(scenario.state ?? {}),
      status: "failed",
      prompt: null,
      reason: "code_rejected",
    };
    await advance(1000);

    expect(byId(ui, "login-status").textContent).toBe("The provider rejected the code.");
    expect(byId(ui, "login-start").classList.contains("hidden")).toBe(false);
  });

  it.each([
    ["cancelled", null, "The login was cancelled."],
    ["timeout", null, "The login timed out. Start again."],
    ["failed", "code_rejected", "The provider rejected the code."],
    ["failed", "failed", "The login failed. Start again."],
  ])("says how a login that ended as %s reads", async (status, reason, sentence) => {
    const ui = await page();
    await openLoginPanel(ui);
    fakeClock();
    press(ui, byId(ui, "login-start"));
    await advance(0);

    scenario.state = { ...(scenario.state ?? {}), status, prompt: null, reason };
    await advance(1000);
    expect(byId(ui, "login-status").textContent).toBe(sentence);
    // A finished login is the form's again: Start is one press away.
    expect(byId(ui, "login-start").classList.contains("hidden")).toBe(false);
  });

  it("shows the daemon's warning about a login it could not record", async () => {
    const ui = await page();
    await openLoginPanel(ui);
    fakeClock();
    press(ui, byId(ui, "login-start"));
    await advance(0);
    scenario.state = {
      status: "prompt",
      provider: "anthropic",
      type: "oauth",
      prompt: { type: "text", message: "Paste the code" },
      events: [],
      startedAt: "2026-10-24T00:00:00.000Z",
      finishedAt: null,
      loginAt: null,
      reason: null,
      warning: "the login time was not recorded in /home/test/.pi/sec/model-login.json: a permission",
    };
    await advance(1000);
    expect(ui.document.querySelector("#login-prompt .login-warning")?.textContent).toContain("was not recorded");
  });

  it("cancels a login and stops asking about it", async () => {
    const ui = await page();
    await openLoginPanel(ui);
    fakeClock();
    press(ui, byId(ui, "login-start"));
    await advance(0);
    const before = ui.fetchCalls.filter((call) => call.path === "/api/admin/model-login/state").length;

    press(ui, byId(ui, "login-cancel"));
    await advance(0);
    const cancel = ui.fetchCalls.find((call) => call.path === "/api/admin/model-login/cancel");
    expect(JSON.parse(cancel?.body ?? "null")).toEqual({ session: "session-1" });
    expect(byId(ui, "login-status").textContent).toBe("The login was cancelled.");
    expect(byId(ui, "login-start").classList.contains("hidden")).toBe(false);

    // Nothing is read once the login is over.
    await advance(5000);
    expect(ui.fetchCalls.filter((call) => call.path === "/api/admin/model-login/state").length).toBeLessThanOrEqual(
      before + 1,
    );
  });

  it("says the session is gone when the daemon no longer knows it", async () => {
    const ui = await page();
    await openLoginPanel(ui);
    fakeClock();
    press(ui, byId(ui, "login-start"));
    await advance(0);

    ui.respond("/api/admin/model-login/state", {
      status: 404,
      body: { error: { code: "login_not_found", message: "no login session carries that id" } },
    });
    await advance(1000);
    expect(byId(ui, "login-status").textContent).toBe("That login session is gone. Start again.");
    expect(byId(ui, "login-start").classList.contains("hidden")).toBe(false);
  });

  it("says a refusal in its own words, never the daemon's", async () => {
    const ui = await page();
    await openLoginPanel(ui);
    fakeClock();
    ui.respond("/api/admin/model-login/start", {
      status: 409,
      body: { error: { code: "login_busy", message: "a login is already running; finish or cancel it first" } },
    });
    press(ui, byId(ui, "login-start"));
    await advance(0);
    const line = byId(ui, "login-error").textContent ?? "";
    expect(line).toBe("A login is already running. Cancel it, or wait for it to end.");
    expect(line).not.toContain("finish or cancel it first");
  });

  it("stops asking when the panel closes, and picks the login up when it opens", async () => {
    const ui = await page();
    await openLoginPanel(ui);
    fakeClock();
    press(ui, byId(ui, "login-start"));
    await advance(0);

    press(ui, byId(ui, "login-pane-close"));
    await advance(0);
    const afterClose = ui.fetchCalls.filter((call) => call.path === "/api/admin/model-login/state").length;
    await advance(5000);
    expect(ui.fetchCalls.filter((call) => call.path === "/api/admin/model-login/state").length).toBe(afterClose);

    // Opened again, the login this page started is read at once.
    press(ui, byId(ui, "model-login"));
    await advance(0);
    await advance(0);
    expect(ui.fetchCalls.filter((call) => call.path === "/api/admin/model-login/state").length).toBeGreaterThan(
      afterClose,
    );
  });

  it("keeps a sign-in that only a choice can answer waiting for it", async () => {
    const ui = await page();
    await openLoginPanel(ui);
    fakeClock();
    press(ui, byId(ui, "login-start"));
    await advance(0);

    // The same question, read again: no new field, and nothing sent.
    const field = ui.document.getElementById("login-answer");
    await advance(1000);
    expect(ui.document.getElementById("login-answer")).toBe(field);
    expect(scenario.answers).toEqual([]);
  });

  it("lets a typed answer through without sending it on a poll", async () => {
    const ui = await page();
    await openLoginPanel(ui);
    fakeClock();
    press(ui, byId(ui, "login-start"));
    await advance(0);
    type(ui, byId(ui, "login-answer"), "half-typed");
    await advance(3000);
    expect(scenario.answers).toEqual([]);
    expect((byId(ui, "login-answer") as HTMLInputElement).value).toBe("half-typed");
  });
});
