/**
 * The setup card and the model form on the assembled chat page.
 *
 * The daemon is a stub. `GET /api/admin/status` says whether the daemon is in
 * setup mode, `GET /api/admin/model-setup/models` lists the models, and the two
 * writes record what the page sent. The tests pin: the card follows the status,
 * the card's buttons open the login panel and send the reload, the form lists only
 * what the daemon listed, and the body carries only the fields the operator chose.
 */
import { afterEach, describe, expect, it } from "vitest";
import type { UiPageHandle } from "./harness.ts";
import { byId, callsTo, loadChatPage, more, press, tick } from "./chat-harness.ts";

let open: UiPageHandle | undefined;

afterEach(() => {
  open?.close();
  open = undefined;
});

const STATUS_SETUP = { restartRequired: false, restartReady: false, configError: null, notes: [], modelSetupRequired: true, vmodelKeys: [] };

const MODELS = {
  providers: [
    { id: "anthropic", models: [{ id: "claude-a", name: "Claude A" }, { id: "claude-b", name: "Claude B" }] },
    { id: "openrouter", models: [{ id: "vendor/some-model", name: "Some Model" }] },
  ],
  existingVmodels: [] as string[],
  modelSetupRequired: true,
};

interface Options {
  status?: Record<string, unknown>;
  models?: Record<string, unknown>;
  save?: { status: number; body: unknown };
  reload?: { status: number; body: unknown };
}

async function page(options: Options = {}): Promise<UiPageHandle> {
  open = await loadChatPage({
    fetch: {
      "/api/admin/status": { body: options.status ?? STATUS_SETUP },
      "/api/admin/model-setup/models": { body: options.models ?? MODELS },
      "/api/admin/model-setup": options.save ?? { body: { status: "saved" } },
      "/api/admin/reload": options.reload ?? { body: { status: "reloaded" } },
    },
  });
  return open;
}

const select = (ui: UiPageHandle, id: string): HTMLSelectElement => byId<HTMLSelectElement>(ui, id);

function choose(ui: UiPageHandle, id: string, value: string): void {
  const field = select(ui, id);
  field.value = value;
  field.dispatchEvent(new ui.window.Event("change", { bubbles: true }));
}

function saved(ui: UiPageHandle): Record<string, unknown> {
  const calls = callsTo(ui, "/api/admin/model-setup", "POST");
  expect(calls).toHaveLength(1);
  return JSON.parse((calls[0] as { body: string | null }).body ?? "{}") as Record<string, unknown>;
}

describe("the setup card", () => {
  it("shows in setup mode, with the composer off and no 'offline'", async () => {
    const ui = await page();
    expect(byId(ui, "setup-card").classList.contains("hidden")).toBe(false);
    expect(byId(ui, "setup-card").textContent).toContain("Sign a provider in");
    expect(byId(ui, "setup-card").textContent).toContain("Load the configuration");
    expect((byId(ui, "message") as HTMLTextAreaElement).disabled).toBe(true);
    expect((byId(ui, "send") as HTMLButtonElement).disabled).toBe(true);
    expect(byId(ui, "connection").textContent).not.toContain("offline");
    expect(byId(ui, "activity").classList.contains("hidden")).toBe(true);
  });

  it("is hidden when the daemon has a model", async () => {
    const ui = await page({ status: { ...STATUS_SETUP, modelSetupRequired: false, vmodelKeys: ["root"] } });
    expect(byId(ui, "setup-card").classList.contains("hidden")).toBe(true);
    expect(byId(ui, "setup-card").textContent).toBe("");
    expect((byId(ui, "message") as HTMLTextAreaElement).disabled).toBe(false);
    expect(callsTo(ui, "/api/admin/model-setup/models")).toHaveLength(0);
  });

  it("opens the login panel from step 1 and reads the list again when the panel closes", async () => {
    const ui = await page();
    expect(callsTo(ui, "/api/admin/model-setup/models")).toHaveLength(1);
    press(ui, byId(ui, "setup-login"));
    await more(3);
    expect(ui.document.body.dataset.login).toBe("open");
    press(ui, byId(ui, "login-pane-close"));
    await more(3);
    expect(ui.document.body.dataset.login).not.toBe("open");
    expect(callsTo(ui, "/api/admin/model-setup/models")).toHaveLength(2);
  });

  it("sends the reload from step 3 and loads the page again when setup ended", async () => {
    const ui = await page();
    ui.respond("/api/admin/status", { body: { ...STATUS_SETUP, modelSetupRequired: false } });
    press(ui, byId(ui, "setup-reload"));
    await more(4);
    expect(callsTo(ui, "/api/admin/reload", "POST")).toHaveLength(1);
    expect(ui.navigations).toHaveLength(1);
  });

  it("shows the problem sentences of a reload that failed and does not reload the page", async () => {
    const ui = await page({
      reload: { status: 400, body: { status: "config_failed", issues: ["agent.vmodel: unknown vmodel", "second problem"] } },
    });
    press(ui, byId(ui, "setup-reload"));
    await more(4);
    const text = byId(ui, "setup-issues").textContent ?? "";
    expect(text).toContain("agent.vmodel: unknown vmodel");
    expect(text).toContain("second problem");
    expect(ui.navigations).toHaveLength(0);
  });
});

describe("the model form", () => {
  it("lists the models of the signed-in providers, grouped by provider", async () => {
    const ui = await page();
    const groups = [...select(ui, "setup-model").querySelectorAll("optgroup")];
    expect(groups.map((group) => group.label)).toEqual(["anthropic", "openrouter"]);
    expect(groups[0]?.querySelectorAll("option")).toHaveLength(2);
    expect(groups[1]?.textContent).toContain("Some Model");
    expect(select(ui, "setup-thinking").value).toBe("medium");
    expect((byId(ui, "setup-save") as HTMLButtonElement).disabled).toBe(true);
  });

  it("says to finish step 1 and shows no list when no provider is signed in", async () => {
    const ui = await page({ models: { ...MODELS, providers: [] } });
    expect(byId(ui, "setup-no-provider").textContent).toContain("step 1");
    expect(ui.document.getElementById("setup-model")).toBeNull();
    expect(ui.document.getElementById("setup-save")).toBeNull();
  });

  it("shows the replace box only when config.json has one of the four vmodels", async () => {
    const none = await page();
    expect(none.document.getElementById("setup-force")).toBeNull();
    none.close();
    const some = await page({ models: { ...MODELS, existingVmodels: ["worker"] } });
    expect(some.document.getElementById("setup-force")).not.toBeNull();
    expect(byId(some, "setup-card").textContent).toContain("scheduled job");
  });

  it("sends only the chosen fields, and the model id keeps its slash", async () => {
    const ui = await page();
    choose(ui, "setup-model", "openrouter|vendor/some-model");
    await more(2);
    press(ui, byId(ui, "setup-save"));
    await more(4);
    expect(saved(ui)).toEqual({ provider: "openrouter", model: "vendor/some-model", thinking: "medium" });
    expect(ui.navigations).toHaveLength(1);
  });

  it("sends the thinking level, the worker model and the replace flag when they are chosen", async () => {
    const ui = await page({ models: { ...MODELS, existingVmodels: ["root", "worker"] } });
    choose(ui, "setup-model", "anthropic|claude-a");
    choose(ui, "setup-thinking", "high");
    const section = byId<HTMLDetailsElement>(ui, "setup-worker-section");
    section.open = true;
    section.dispatchEvent(new ui.window.Event("toggle"));
    await more(2);
    choose(ui, "setup-worker", "anthropic|claude-b");
    tick(ui, byId(ui, "setup-force"), true);
    await more(2);
    press(ui, byId(ui, "setup-save"));
    await more(4);
    expect(saved(ui)).toEqual({
      provider: "anthropic",
      model: "claude-a",
      thinking: "high",
      workerProvider: "anthropic",
      workerModel: "claude-b",
      force: true,
    });
  });

  it("shows the refusal sentence of the route and keeps the form", async () => {
    const ui = await page({
      save: {
        status: 409,
        body: { error: { code: "write_refused", message: "config.json already has vmodels; pass --force to replace them", requestId: "r1" } },
      },
      models: { ...MODELS, existingVmodels: ["root"] },
    });
    choose(ui, "setup-model", "anthropic|claude-a");
    await more(2);
    press(ui, byId(ui, "setup-save"));
    await more(4);
    const line = byId(ui, "setup-error").textContent ?? "";
    expect(line).toContain("config.json already has vmodels; pass --force to replace them");
    expect(line).toContain("Replace existing vmodels");
    expect(ui.navigations).toHaveLength(0);
    expect(select(ui, "setup-model").value).toBe("anthropic|claude-a");
  });
});
