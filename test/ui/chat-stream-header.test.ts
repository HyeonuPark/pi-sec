/**
 * The top bar: the conversation's name, the rename a press on it asks for, and the
 * five banners that appear only when they have something to say.
 *
 * The name is the install's on the root, the chat's title on a focused chat,
 * `Untitled` before the agent names one, `Chat not found` for a number the server
 * does not know. A chat the page cannot write to keeps its transcript and loses the
 * composer, and one line takes the composer's place.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadStreamPage, type StreamPage } from "./chat-stream-harness.ts";

let open: StreamPage | undefined;

afterEach(() => {
  vi.useRealTimers();
  open?.close();
  open = undefined;
});

async function page(options: Parameters<typeof loadStreamPage>[0] = {}): Promise<StreamPage> {
  open = await loadStreamPage(options);
  return open;
}

async function flush(): Promise<void> {
  // A read answers on a task, and a signal notifies its readers in a microtask.
  await new Promise((resolve) => setTimeout(resolve, 0));
  await Promise.resolve();
  await Promise.resolve();
}

const title = (ui: StreamPage) => ui.document.getElementById("chat-title") as HTMLButtonElement;
const mark = (ui: StreamPage) => ui.document.getElementById("chat-mark") as HTMLElement;
const notice = (ui: StreamPage) => ui.document.getElementById("chat-notice") as HTMLElement;
const composer = (ui: StreamPage) => ui.document.getElementById("composer") as HTMLFormElement;
const banner = (ui: StreamPage, id: string) => ui.document.getElementById(id) as HTMLButtonElement;

describe("the chat's name in the top bar", () => {
  it("shows the personality's name on the root conversation", async () => {
    const ui = await page({ name: "Bob" });
    expect(title(ui).textContent).toBe("Bob");
    expect(title(ui).title).toBe("Bob");
    expect(title(ui).disabled).toBe(true);
    expect(mark(ui).classList.contains("hidden")).toBe(true);
    expect(ui.document.body.dataset.chat).toBe("root");
    expect(ui.document.title).toBe("pi-sec");
  });

  it("falls back to the app's own name when the personality has none", async () => {
    const ui = await page();
    expect(title(ui).textContent).toBe("pi-sec");
  });

  it("shows a focused chat's title, the mark, the bar's colour and the tab title", async () => {
    const ui = await page({ chat: 7, name: "Bob", fetch: { "/api/focused-chats/7": { body: { title: "Reading a report" } } } });
    expect(title(ui).textContent).toBe("Reading a report");
    expect(title(ui).disabled).toBe(false);
    expect(mark(ui).classList.contains("hidden")).toBe(false);
    expect(ui.document.body.dataset.chat).toBe("focused");
    expect(ui.document.title).toBe("Reading a report · pi-sec");
  });

  it("shows `Untitled` for a chat the agent has not named yet", async () => {
    const ui = await page({ chat: 7, fetch: { "/api/focused-chats/7": { body: { title: "" } } } });
    expect(title(ui).textContent).toBe("Untitled");
    expect(ui.document.title).toBe("Untitled · pi-sec");
  });

  it("says `Chat not found` for a number the server does not know, and takes the composer away", async () => {
    const ui = await page({ chat: 9, fetch: { "/api/focused-chats/9": { status: 404, body: {} } } });
    expect(title(ui).textContent).toBe("Chat not found");
    expect(title(ui).disabled).toBe(true);
    expect(notice(ui).classList.contains("hidden")).toBe(false);
    expect(notice(ui).textContent).toBe("This chat does not exist or was deleted. All chats");
    expect(notice(ui).querySelector("a")?.getAttribute("href")).toBe("/chats");
    expect(composer(ui).classList.contains("hidden")).toBe(true);
  });

  it("keeps an archived chat's transcript and loses its composer", async () => {
    const ui = await page({ chat: 7, fetch: { "/api/focused-chats/7": { body: { title: "Done", archived: true } } } });
    expect(notice(ui).classList.contains("hidden")).toBe(false);
    expect(notice(ui).textContent).toBe("This chat is archived. All chats");
    expect(composer(ui).classList.contains("hidden")).toBe(true);
    expect(title(ui).disabled).toBe(true);
  });

  it("carries the mount prefix into the notice's list link", async () => {
    const ui = await page({
      base: "/sec",
      chat: 7,
      fetch: { "/api/focused-chats/7": { body: { title: "Gone", archived: true } } },
    });
    expect(notice(ui).querySelector("a")?.getAttribute("href")).toBe("/sec/chats");
  });
});

describe("renaming a focused chat", () => {
  it("asks for a new title and sends it, then draws the answer", async () => {
    const ui = await page({ chat: 7, fetch: { "/api/focused-chats/7": { body: { title: "Old name" } } } });
    ui.window.prompt = () => "  New name  ";
    ui.respond("/api/focused-chats/7", (request) =>
      request.method === "PATCH" ? { body: { title: "New name" } } : { body: { title: "Old name" } },
    );

    title(ui).click();
    await flush();

    const patch = ui.fetchCalls.filter((call) => call.method === "PATCH").at(-1);
    expect(patch?.path).toBe("/api/focused-chats/7");
    expect(JSON.parse(patch?.body ?? "{}")).toEqual({ title: "New name" });
    expect(title(ui).textContent).toBe("New name");
  });

  it("refuses an empty title before the request", async () => {
    const ui = await page({ chat: 7, fetch: { "/api/focused-chats/7": { body: { title: "Old name" } } } });
    ui.window.prompt = () => "   ";
    title(ui).click();
    await flush();
    expect(ui.fetchCalls.filter((call) => call.method === "PATCH")).toHaveLength(0);
    expect(ui.toast.toast.value.text).toBe("A title cannot be empty.");
  });

  it("sends nothing when the question is refused", async () => {
    const ui = await page({ chat: 7, fetch: { "/api/focused-chats/7": { body: { title: "Old name" } } } });
    ui.window.prompt = () => null;
    title(ui).click();
    await flush();
    expect(ui.fetchCalls.filter((call) => call.method === "PATCH")).toHaveLength(0);
  });

  it("treats a 409 chat_archived as the chat becoming read-only", async () => {
    const ui = await page({ chat: 7, fetch: { "/api/focused-chats/7": { body: { title: "Old name" } } } });
    ui.window.prompt = () => "New name";
    ui.respond("/api/focused-chats/7", (request) =>
      request.method === "PATCH"
        ? { status: 409, body: { error: { code: "chat_archived", message: "This chat is archived." } } }
        : { body: { title: "Old name" } },
    );

    title(ui).click();
    await flush();

    expect(ui.toast.toast.value.text).toBe("This chat is archived, so its title can no longer change.");
    expect(notice(ui).textContent).toBe("This chat is archived. All chats");
    expect(composer(ui).classList.contains("hidden")).toBe(true);
    expect(title(ui).disabled).toBe(true);
  });

  it("shows the server's sentence when the rename fails for another reason", async () => {
    const ui = await page({ chat: 7, fetch: { "/api/focused-chats/7": { body: { title: "Old name" } } } });
    ui.window.prompt = () => "New name";
    ui.respond("/api/focused-chats/7", (request) =>
      request.method === "PATCH"
        ? { status: 500, body: { error: { code: "boom", message: "The store is busy." } } }
        : { body: { title: "Old name" } },
    );
    title(ui).click();
    await flush();
    expect(ui.toast.toast.value.text).toBe("The store is busy.");
    expect(title(ui).textContent).toBe("Old name");
  });
});

describe("the chat's live metadata", () => {
  it("follows a rename that arrives as a frame", async () => {
    const ui = await page({ chat: 7, fetch: { "/api/focused-chats/7": { body: { title: "Old name" } } } });
    ui.emit("focused_chat_updated", { conversationId: 7, title: "Renamed elsewhere", change: "updated" });
    await flush();
    expect(title(ui).textContent).toBe("Renamed elsewhere");
  });

  it("switches the page to the missing state when the frame says the chat was deleted", async () => {
    const ui = await page({ chat: 7, fetch: { "/api/focused-chats/7": { body: { title: "Old name" } } } });
    ui.emit("focused_chat_updated", { conversationId: 7, change: "deleted" });
    await flush();
    expect(title(ui).textContent).toBe("Chat not found");
    expect(notice(ui).textContent).toBe("This chat does not exist or was deleted. All chats");
  });

  it("follows the archive state the event spells as a time", async () => {
    const ui = await page({ chat: 7, fetch: { "/api/focused-chats/7": { body: { title: "Old name" } } } });
    ui.emit("focused_chat_updated", { conversationId: 7, title: "Old name", archivedAt: 1_700_000_000_000 });
    await flush();
    expect(notice(ui).textContent).toBe("This chat is archived. All chats");
  });

  it("ignores a frame about another chat", async () => {
    const ui = await page({ chat: 7, fetch: { "/api/focused-chats/7": { body: { title: "Mine" } } } });
    ui.emit("focused_chat_updated", { conversationId: 8, title: "Theirs", change: "updated" });
    await flush();
    expect(title(ui).textContent).toBe("Mine");
  });

  it("ignores every chat frame on the root conversation, which has no number", async () => {
    const ui = await page({ name: "Bob" });
    ui.emit("focused_chat_updated", { conversationId: 8, title: "Theirs", change: "updated" });
    await flush();
    expect(title(ui).textContent).toBe("Bob");
    expect(notice(ui).classList.contains("hidden")).toBe(true);
  });
});

describe("the header banners", () => {
  it("says when a core change is staged and when it is ready to apply", async () => {
    const ui = await page({
      fetch: { "/api/admin/status": { body: { restartRequired: true, restartReady: false } } },
    });
    await flush();
    expect(banner(ui, "restart-banner").classList.contains("hidden")).toBe(false);
    expect(banner(ui, "restart-banner").textContent).toBe("Core change staged — restart not ready yet");
    expect(banner(ui, "restart-banner").title).toContain("a restart now could boot a half-written change");

    ui.emit("restart_required", { ready: true });
    await flush();
    expect(banner(ui, "restart-banner").textContent).toBe("Restart ready — run user-tools/update-and-restart");
    expect(banner(ui, "restart-banner").title).toBe(
      "The gate passed: typecheck, tests, and a secret scan of the change.",
    );

    // The need stays: the banner reports waiting again, it does not disappear.
    ui.emit("restart_withdrawn", {});
    await flush();
    expect(banner(ui, "restart-banner").classList.contains("hidden")).toBe(false);
    expect(banner(ui, "restart-banner").textContent).toBe("Core change staged — restart not ready yet");
  });

  it("stays hidden when no restart was recorded", async () => {
    const ui = await page();
    await flush();
    expect(banner(ui, "restart-banner").classList.contains("hidden")).toBe(true);
  });

  it("shows the first reason a config reload failed inline, and all of them on a press", async () => {
    const ui = await page({
      fetch: {
        "/api/admin/status": {
          body: { configError: { issues: ["first issue", "second issue"] } },
        },
      },
    });
    await flush();
    expect(banner(ui, "config-banner").classList.contains("hidden")).toBe(false);
    expect(banner(ui, "config-banner").textContent).toBe("Config reload failed — first issue");
    expect(banner(ui, "config-banner").title).toBe("first issue\nsecond issue");
    banner(ui, "config-banner").click();
    await flush();
    expect(ui.toast.toast.value.text).toBe("Config reload failed — first issue · second issue");
  });

  it("says so when neither the stamp nor the path names the mount", async () => {
    const ui = await page({ stamped: false });
    expect(banner(ui, "mount-banner").classList.contains("hidden")).toBe(false);
    expect(banner(ui, "mount-banner").textContent).toBe("Mount point unknown — reload this page from the server");
  });

  it("keeps the mount banner hidden when the stamp is there", async () => {
    const ui = await page();
    expect(banner(ui, "mount-banner").classList.contains("hidden")).toBe(true);
  });

  it("says when the root model has no credential, and opens the login panel on a press", async () => {
    const ui = await page({
      fetch: {
        "/api/admin/model-login/providers": {
          body: { rootProvider: "anthropic", providers: [{ id: "anthropic", configured: false }] },
        },
      },
    });
    await flush();
    expect(banner(ui, "credential-banner").classList.contains("hidden")).toBe(false);
    expect(banner(ui, "credential-banner").textContent).toBe("No credential for anthropic — sign in");

    const banners = await import("../../src/ui/chat/header/Banners.tsx");
    const press = vi.fn();
    const off = banners.onCredentialPress(press);
    banner(ui, "credential-banner").click();
    expect(press).toHaveBeenCalledTimes(1);
    off();
    banner(ui, "credential-banner").click();
    expect(press).toHaveBeenCalledTimes(1);
  });

  it("says which provider holds conversations for a usage limit, and takes the line down when it ends", async () => {
    const resets = Date.UTC(2026, 10, 3, 2, 0);
    const ui = await page({
      fetch: {
        "/api/admin/status": {
          body: {
            usageHold: [
              { provider: "anthropic", conversations: 2, readable: true, resetsAt: resets },
            ],
          },
        },
      },
    });
    await flush();
    expect(banner(ui, "usage-banner").classList.contains("hidden")).toBe(false);
    expect(banner(ui, "usage-banner").textContent).toContain("anthropic usage limit");
    expect(banner(ui, "usage-banner").textContent).toContain("2 conversations held");
    // The reset time is the provider's own, drawn in the harness zone the page was stamped with.
    expect(banner(ui, "usage-banner").title).toContain("anthropic usage limit");
    expect(banner(ui, "usage-banner").title).toContain("Open the usage page");

    // The provider recovered: the event says so, and the page re-reads the status,
    // which now holds an empty list. That is what takes the line down.
    ui.respond("/api/admin/status", { body: { usageHold: [] } });
    ui.emit("usage_hold_changed", { providers: [] });
    await flush();
    expect(banner(ui, "usage-banner").classList.contains("hidden")).toBe(true);
    expect(banner(ui, "usage-banner").textContent).toBe("");
  });

  it("says a provider whose usage cannot be read is checked with a short request", async () => {
    const ui = await page({
      fetch: {
        "/api/admin/status": {
          body: {
            usageHold: [
              {
                provider: "openai",
                conversations: 1,
                readable: false,
                lastProbeResult: "rate_limited",
                nextProbeAt: Date.UTC(2026, 10, 3, 2, 10),
              },
            ],
          },
        },
      },
    });
    await flush();
    expect(banner(ui, "usage-banner").classList.contains("hidden")).toBe(false);
    expect(banner(ui, "usage-banner").textContent).toContain("1 conversation held");
    expect(banner(ui, "usage-banner").textContent).toContain("next check");
    expect(banner(ui, "usage-banner").textContent).toContain("still refused");
    expect(banner(ui, "usage-banner").textContent).toContain("usage not readable");
  });

  it("keeps the usage line hidden while no provider holds a conversation", async () => {
    const ui = await page();
    await flush();
    expect(banner(ui, "usage-banner").classList.contains("hidden")).toBe(true);
  });

  it("hides the credential banner when the provider is configured", async () => {
    const ui = await page({
      fetch: {
        "/api/admin/model-login/providers": {
          body: { rootProvider: "anthropic", providers: [{ id: "anthropic", configured: true }] },
        },
      },
    });
    await flush();
    expect(banner(ui, "credential-banner").classList.contains("hidden")).toBe(true);
  });
});
