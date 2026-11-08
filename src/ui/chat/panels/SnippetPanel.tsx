/**
 * The text snippet panel.
 *
 * One form, two ways out. In the ordinary mode the body becomes a
 * `text/plain` file on the next message, so the agent reads it only if it looks
 * and a long note stays out of the context; with the secret switch on, the same
 * form writes a file under the secrets directory and the body never becomes a
 * message, a chip or an error sentence.
 *
 * The three fields are read from and written to `src/ui/state/snippets.ts`, so a
 * stream frame or a panel closed by a stray press leaves what was typed where it
 * was. The field itself is the same element across those redraws, which is what
 * keeps the caret and the focus too.
 */
import type { JSX } from "preact";

import {
  closeSnippetPanel,
  setSnippetMode,
  snippetBody,
  snippetError,
  snippetHint,
  snippetName,
  snippetPlaceholder,
  snippetSecret,
  snippetSubmitLabel,
  submitSnippet,
} from "../../state/snippets.ts";

/**
 * `spellcheck="false"`, as the shell wrote it.
 *
 * Preact treats `spellcheck` as a property, and a property is not an attribute:
 * the element would answer `spellcheck === false` while its markup said nothing,
 * which is the one thing the shell's own markup does not do. Writing the attribute
 * keeps the element what the shell wrote, and keeps the browser's own spell
 * checker off the field all the same.
 */
function noSpelling(element: HTMLElement | null): void {
  element?.setAttribute("spellcheck", "false");
}

export function SnippetPanel() {
  const secret = snippetSecret.value;
  return (
    <aside id="snippet-pane" class="snippet-pane" aria-label="Text snippet">
      <div class="snippet-pane-head">
        <h2 class="snippet-pane-title">Text snippet</h2>
        <button
          id="snippet-pane-close"
          class="button"
          type="button"
          aria-label="Close the snippet panel"
          onClick={() => closeSnippetPanel()}
        >
          ✕
        </button>
      </div>
      <label class="snippet-field">
        <span class="snippet-label">Name</span>
        <input
          id="snippet-name"
          class="snippet-input"
          type="text"
          placeholder={snippetPlaceholder()}
          autocomplete="off"
          ref={noSpelling}
          value={snippetName.value}
          onInput={(event) => {
            snippetName.value = event.currentTarget.value;
          }}
        />
      </label>
      <label class="snippet-switch">
        <input
          id="snippet-secret"
          type="checkbox"
          checked={secret}
          onChange={(event) => setSnippetMode(event.currentTarget.checked)}
        />
        <span>Store as a secret</span>
      </label>
      <p id="snippet-hint" class="snippet-hint">
        {snippetHint()}
      </p>
      <label class="snippet-field snippet-field-body">
        <span class="snippet-label">Body</span>
        <textarea
          id="snippet-body"
          class="snippet-body"
          rows={8}
          ref={noSpelling}
          value={snippetBody.value}
          onInput={(event) => {
            snippetBody.value = event.currentTarget.value;
          }}
        ></textarea>
      </label>
      <div class="snippet-actions">
        <button
          id="snippet-submit"
          class="button button-primary"
          type="button"
          onClick={() => void submitSnippet()}
        >
          {snippetSubmitLabel()}
        </button>
      </div>
      <p id="snippet-error" class="snippet-error" role="status">
        {snippetError.value}
      </p>
    </aside>
  );
}
