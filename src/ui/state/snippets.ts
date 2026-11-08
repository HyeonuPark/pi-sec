/**
 * The text snippet panel: a name, a secret switch and a body.
 *
 * Two modes come out of one form. Off, the body becomes a `text/plain` attachment
 * on the next message, so it reaches the model only when the agent reads the
 * file, and the chip it leaves behind is the one a picked file already makes. On,
 * the same body is written under the secrets directory, the name is required, and
 * the body never becomes a message or an error sentence: a refused write says a
 * fixed sentence with the server's code in it, and nothing else.
 *
 * The three fields are the operator's, so they live here and not in the DOM: a
 * stream frame, a reconnection or a panel closed by a stray press leaves what was
 * typed where it was. The one thing that moves without the operator is the line
 * under the button, and only the press that submits writes it.
 */
import { signal } from "@preact/signals";
import { ApiError, request } from "../api/request.ts";
import { addAttachmentFiles } from "./attachments.ts";
import { closePane, paneIsOpen, takeSlot } from "./panels.ts";

/** The name the file is filed under. */
export const snippetName = signal("");

/** The body: the text of the file, or the secret's value. */
export const snippetBody = signal("");

/** Whether the body is a secret rather than an attachment. */
export const snippetSecret = signal(false);

/** The one line under the button: a progress word or a refusal. */
export const snippetError = signal("");

/** What the ordinary mode says above the body. */
export const SNIPPET_ATTACH_HINT = "The body goes with your next message as a text file.";

/** What the secret mode says. The path is the default one; the server resolves the real one. */
export const SNIPPET_SECRET_HINT =
  "This body is written to ~/.pi/sec/secrets/<name>. A name that already exists fails.";

/** The placeholder the name field carries in each mode. */
export function snippetPlaceholder(): string {
  return snippetSecret.value ? "name required" : "snippet";
}

/** The word the button carries in each mode. */
export function snippetSubmitLabel(): string {
  return snippetSecret.value ? "Upload secret" : "Attach";
}

/** The hint the panel shows above the body. */
export function snippetHint(): string {
  return snippetSecret.value ? SNIPPET_SECRET_HINT : SNIPPET_ATTACH_HINT;
}

/** The one line under the button, written by the press that has something to say. */
export function setSnippetError(text: string): void {
  snippetError.value = text;
}

/**
 * Turn the secret switch, and redraw what depends on it.
 *
 * The name is emptied in both directions: a secret has no default name (the name
 * is what the file is called and the server refuses to invent one), and a body
 * typed for a secret must not be filed under the name it was typed beside.
 */
export function setSnippetMode(secret: boolean): void {
  snippetSecret.value = secret;
  snippetName.value = "";
  setSnippetError("");
}

/** Open the snippet panel in the slot, in the mode it was last left in. */
export function openSnippetPanel(): void {
  takeSlot("snippet");
  setSnippetError("");
}

/** Whether the snippet panel is the panel in the slot. */
export function snippetPanelIsOpen(): boolean {
  return paneIsOpen("snippet");
}

/** Close the snippet panel, if it is the one in the slot. */
export function closeSnippetPanel(): void {
  if (snippetPanelIsOpen()) closePane();
}

/**
 * The name a snippet is filed under.
 *
 * The last path segment only, trimmed, with control characters removed, and
 * `snippet` when nothing is left. It is a label here and the seed of the stored
 * name on the server, which cleans it again.
 */
export function snippetFileName(raw: unknown): string {
  const last = String(raw ?? "")
    .split(/[\\/]/)
    .pop() ?? "";
  const cleaned = last.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  return cleaned === "" ? "snippet" : cleaned;
}

/** The fields of a refusal this module reads. `ApiError` carries both. */
interface Refusal {
  readonly code?: unknown;
  readonly status?: unknown;
}

/**
 * What a refused secret write says.
 *
 * The sentences are fixed here and carry the server's code, never its message:
 * the body that was sent must not come back through an error line.
 */
export function secretWriteMessage(failure: Refusal | undefined): string {
  const code = typeof failure?.code === "string" ? failure.code : "";
  if (code === "invalid_name") return "That name cannot be used (invalid_name).";
  if (code === "empty_secret") return "The body is empty (empty_secret).";
  if (code === "name_exists") return "A secret with that name already exists (name_exists).";
  const status = typeof failure?.status === "number" ? failure.status : 0;
  if (code === "write_failed" || status === 500) return "The secret was not written (write_failed).";
  if (status === 413) return "The body is too large (413).";
  if (status === 415) return "The request was not JSON (415).";
  if (status === 400) return "The name or the body was refused (400).";
  return status === 0 ? "The secret was not written." : `The secret was not written (${status}).`;
}

/** What `POST /api/admin/secrets/write` answers. */
interface SecretWriteAnswer {
  readonly name?: unknown;
}

/**
 * Take what the panel holds, one of two ways.
 *
 * The ordinary mode makes one `File` and hands it to the path a picked file
 * takes, so the chip, the upload and the ids of the next message are the ones
 * that already exist. The secret mode posts the body to the secrets route and
 * keeps the name for the next value.
 */
export async function submitSnippet(): Promise<void> {
  const text = snippetBody.value;

  if (snippetSecret.value) {
    const name = snippetName.value.trim();
    if (name === "") {
      setSnippetError("name required");
      return;
    }
    if (text === "") {
      setSnippetError(secretWriteMessage({ code: "empty_secret" }));
      return;
    }
    setSnippetError("uploading…");
    let answer: SecretWriteAnswer | undefined;
    try {
      answer = await request<SecretWriteAnswer>("/api/admin/secrets/write", {
        method: "POST",
        body: JSON.stringify({ name, text }),
      });
    } catch (failure) {
      // The failure keeps the body out of the line: only the code and the status
      // are read, and the server's own message is not printed.
      setSnippetError(secretWriteMessage(failure instanceof ApiError ? failure : undefined));
      return;
    }
    snippetBody.value = "";
    const stored = typeof answer?.name === "string" && answer.name !== "" ? answer.name : name;
    setSnippetError(`uploaded ${stored}`);
    return;
  }

  if (text === "") {
    // A zero byte file is refused by the upload route, so it is not sent to fail
    // there as a chip that never becomes sendable.
    setSnippetError("The body is empty.");
    return;
  }
  const file = new File([text], snippetFileName(snippetName.value), { type: "text/plain; charset=utf-8" });
  addAttachmentFiles([file]);
  snippetBody.value = "";
  setSnippetError("");
  closeSnippetPanel();
}

/** Put this module back where a freshly loaded page starts. */
export function resetSnippetState(): void {
  snippetName.value = "";
  snippetBody.value = "";
  snippetSecret.value = false;
  snippetError.value = "";
}
