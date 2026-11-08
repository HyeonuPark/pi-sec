/**
 * The text snippet panel, on the assembled chat page.
 *
 * The ordinary mode has a name, a body and one `Attach` button,
 * where the body becomes a `text/plain` file on the path a picked file already
 * takes, so a chip appears in the tray and the next Send carries it.
 * The secret mode is this: the same form writes the body under the secrets
 * directory, the name is required, and the body never comes back through the
 * screen — not in the line under the button, not anywhere in the panel.
 *
 * Every request here is answered by the test's own fake `fetch`, so nothing
 * reaches a daemon and no file is really uploaded.
 */
import { afterEach, describe, expect, it } from "vitest";
import type { UiPageHandle } from "./harness.ts";
import {
  byId,
  escape,
  loadChatPage,
  more,
  openSnippetPanel,
  press,
  tick,
  type,
} from "./chat-harness.ts";

let open: UiPageHandle | undefined;

afterEach(() => {
  open?.close();
  open = undefined;
});

/** The page a snippet panel is one press away on. */
async function page(options: Parameters<typeof loadChatPage>[0] = {}): Promise<UiPageHandle> {
  open = await loadChatPage(options);
  return open;
}

/** Fill the form and press its button, the way an operator does. */
async function submit(
  ui: UiPageHandle,
  fields: { readonly name?: string; readonly body: string; readonly secret?: boolean },
): Promise<void> {
  if ((byId<HTMLInputElement>(ui, "snippet-secret").checked === true) !== (fields.secret === true)) {
    // The switch first: turning it is what empties the name field.
    tick(ui, byId(ui, "snippet-secret"), fields.secret === true);
    await more(1);
  }
  if (fields.name !== undefined) type(ui, byId(ui, "snippet-name"), fields.name);
  type(ui, byId(ui, "snippet-body"), fields.body);
  press(ui, byId(ui, "snippet-submit"));
  await more(4);
}

/** The upload requests the page made. */
function uploads(ui: UiPageHandle) {
  return ui.fetchCalls.filter((call) => call.method === "POST" && call.path === "/api/attachments");
}

/** The secret writes the page made. */
function secretWrites(ui: UiPageHandle) {
  return ui.fetchCalls.filter((call) => call.method === "POST" && call.path === "/api/admin/secrets/write");
}

describe("the snippet panel in ordinary mode", () => {
  it("opens from the fourth composer button, after the three pickers", async () => {
    const ui = await page();
    expect(ui.document.body.dataset.snippet).toBe("closed");

    const tools = [...(ui.document.querySelector(".composer-tools")?.querySelectorAll("button") ?? [])].map(
      (button) => button.id,
    );
    expect(tools).toEqual(["attach-image", "attach-camera", "attach-file", "attach-snippet"]);
    expect(byId(ui, "attach-snippet").getAttribute("aria-label")).toBe("Attach a text snippet");

    await openSnippetPanel(ui);
    expect(ui.document.body.dataset.snippet).toBe("open");
    // A panel, not a picker: nothing was picked and nothing was uploaded.
    expect(uploads(ui)).toHaveLength(0);
    expect(byId<HTMLInputElement>(ui, "snippet-name").value).toBe("");
    expect(byId(ui, "snippet-secret")).not.toBeNull();
    expect(byId(ui, "snippet-body")).not.toBeNull();
  });

  it("opens with an empty name field and `snippet` as the placeholder", async () => {
    const ui = await page();
    await openSnippetPanel(ui);
    const name = byId<HTMLInputElement>(ui, "snippet-name");
    // The word the field would be filed under is the placeholder, never a value.
    expect(name.value).toBe("");
    expect(name.placeholder).toBe("snippet");
    expect(byId(ui, "snippet-hint").textContent).toBe("The body goes with your next message as a text file.");
    expect(byId(ui, "snippet-submit").textContent).toBe("Attach");
  });

  it("closes from its own button", async () => {
    const ui = await page();
    await openSnippetPanel(ui);
    press(ui, byId(ui, "snippet-pane-close"));
    await more(2);
    expect(ui.document.body.dataset.snippet).toBe("closed");
  });

  it("files an empty name under `snippet`, and takes the attachment path", async () => {
    const ui = await page();
    await openSnippetPanel(ui);
    await submit(ui, { body: "roadmap for the week" });

    const [upload] = uploads(ui);
    expect(upload?.method).toBe("POST");
    expect(new URL(upload?.url ?? "", "http://localhost").searchParams.get("name")).toBe("snippet");
    expect(upload?.headers["Content-Type"]).toBe("text/plain; charset=utf-8");

    // It joins the tray as a chip, and the panel is done with it.
    expect(byId(ui, "attachment-tray").textContent ?? "").toContain("snippet");
    expect(byId<HTMLTextAreaElement>(ui, "snippet-body").value).toBe("");
    expect(ui.document.body.dataset.snippet).toBe("closed");
    // The message itself is the send button's job, as it is for a picked file.
    expect(ui.fetchCalls.filter((call) => call.path.endsWith("/basic-chat/messages"))).toHaveLength(0);
  });

  it("keeps only the last path segment of a name", async () => {
    const ui = await page();
    await openSnippetPanel(ui);
    await submit(ui, { name: "/tmp/notes/roadmap.md", body: "x" });
    expect(new URL(uploads(ui)[0]?.url ?? "", "http://localhost").searchParams.get("name")).toBe("roadmap.md");
  });

  it("refuses an empty body without sending it", async () => {
    const ui = await page();
    await openSnippetPanel(ui);
    await submit(ui, { body: "" });
    expect(byId(ui, "snippet-error").textContent).toBe("The body is empty.");
    expect(uploads(ui)).toHaveLength(0);
    expect(ui.document.body.dataset.snippet).toBe("open");
  });
});

describe("the snippet panel in secret mode", () => {
  it("asks for a name, and says what it will do with the body", async () => {
    const ui = await page();
    await openSnippetPanel(ui);
    tick(ui, byId(ui, "snippet-secret"), true);
    await more(2);

    expect(byId<HTMLInputElement>(ui, "snippet-name").value).toBe("");
    expect(byId<HTMLInputElement>(ui, "snippet-name").placeholder).toBe("name required");
    expect(byId(ui, "snippet-submit").textContent).toBe("Upload secret");
    const hint = byId(ui, "snippet-hint").textContent ?? "";
    expect(hint).toContain("~/.pi/sec/secrets/");
    // The hint is the page's own sentence: no home directory, no Korean.
    expect(hint).not.toMatch(/[가-힣]/);
    expect(hint).not.toContain("/home/");
  });

  it("refuses a blank name before sending anything", async () => {
    const ui = await page();
    await openSnippetPanel(ui);
    await submit(ui, { name: "   ", body: "value", secret: true });
    expect(byId(ui, "snippet-error").textContent).toBe("name required");
    expect(secretWrites(ui)).toHaveLength(0);
  });

  it("returns to the ordinary mode with an empty name and the `Attach` button", async () => {
    const ui = await page();
    await openSnippetPanel(ui);
    tick(ui, byId(ui, "snippet-secret"), true);
    await more(2);
    type(ui, byId(ui, "snippet-name"), "api_token");
    tick(ui, byId(ui, "snippet-secret"), false);
    await more(2);
    expect(byId<HTMLInputElement>(ui, "snippet-name").value).toBe("");
    expect(byId<HTMLInputElement>(ui, "snippet-name").placeholder).toBe("snippet");
    expect(byId(ui, "snippet-submit").textContent).toBe("Attach");
  });

  it("posts the body to the secrets route, and clears only the body", async () => {
    const ui = await page();
    await openSnippetPanel(ui);
    await submit(ui, { name: "api_token", body: "TOP-SECRET-VALUE", secret: true });

    const [write] = secretWrites(ui);
    expect(write?.method).toBe("POST");
    expect(write?.headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(write?.body ?? "null")).toEqual({ name: "api_token", text: "TOP-SECRET-VALUE" });
    // The ordinary attachment path is not touched in this mode.
    expect(uploads(ui)).toHaveLength(0);

    expect(byId(ui, "snippet-error").textContent).toBe("uploaded api_token");
    expect(byId<HTMLTextAreaElement>(ui, "snippet-body").value).toBe("");
    expect(byId<HTMLInputElement>(ui, "snippet-name").value).toBe("api_token");
    expect(ui.document.body.dataset.snippet).toBe("open");
  });

  it("says what a refusal was, and never the body that was sent", async () => {
    const body = "TOP-SECRET-VALUE";
    const ui = await page({
      fetch: {
        "/api/admin/secrets/write": {
          status: 409,
          body: { error: { code: "name_exists", message: "a secret with that name exists" } },
        },
      },
    });
    await openSnippetPanel(ui);
    await submit(ui, { name: "api_token", body, secret: true });

    const line = byId(ui, "snippet-error").textContent ?? "";
    expect(line).toContain("name_exists");
    // The refusals are the page's own sentences: the daemon's is not repeated.
    expect(line).not.toContain("a secret with that name exists");
    expect(line).not.toContain(body);
    expect(byId(ui, "snippet-pane").textContent ?? "").not.toContain(body);
    expect(ui.document.body.textContent ?? "").not.toContain(body);
    // The form keeps what was typed, so a corrected name does not lose the value.
    expect(byId<HTMLTextAreaElement>(ui, "snippet-body").value).toBe(body);
  });

  it("names each refusal by its status when the server sends no code", async () => {
    const ui = await page({
      fetch: { "/api/admin/secrets/write": { status: 413, text: JSON.stringify({ error: { message: "too big" } }) } },
    });
    await openSnippetPanel(ui);
    await submit(ui, { name: "big", body: "x", secret: true });
    expect(byId(ui, "snippet-error").textContent).toContain("413");
  });
});
