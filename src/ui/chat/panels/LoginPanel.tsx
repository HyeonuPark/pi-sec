/**
 * The model login panel.
 *
 * Pick a provider and a login type, start, then answer what the provider asks.
 * The area under the form carries what the flow said so far (a sign-in link, a
 * device code, a line of progress) and the one question it is waiting on, which
 * is either a field or a list of choices.
 *
 * Two things are drawn so that a poll cannot disturb them.
 *
 * - The two selects are the operator's: their values live in `state/login.ts`, so
 *   a provider list read again keeps the choice and the focus, and only a list
 *   that no longer holds the choice falls back to the root model's provider.
 * - The answer field is one element for one question. It is keyed by what the
 *   question says, so a poll repeating the same question leaves the element, the
 *   pasted key, the caret and the focus alone, and only a different question draws
 *   a new field. What is typed there is never read back into the page's state:
 *   the field is the only place the page holds it, and it is emptied as it is
 *   sent.
 */
import {
  cancelLogin,
  chosenProvider,
  chosenType,
  closeLoginPanel,
  loginAvailable,
  loginError,
  loginIntro,
  loginIsLive,
  loginProviderNote,
  loginProviders,
  loginState,
  loginStatusLine,
  selectedTypes,
  startLogin,
  submitLoginAnswer,
  usableProviders,
} from "../../state/login.ts";
import { openPane } from "../../state/panels.ts";
import { loginTypeLabel } from "../../state/login.ts";
import type { LoginEvent, LoginPrompt } from "../../../shared/wire/login.ts";

/** One link that opens in a new tab, and only for an address a browser may open. */
function LoginLink({ url, label }: { readonly url: unknown; readonly label: string }) {
  if (typeof url === "string" && /^https?:\/\//i.test(url)) {
    return (
      <a class="login-link" href={url} target="_blank" rel="noopener noreferrer">
        {label}
      </a>
    );
  }
  // Anything else is shown as text: a link the page cannot vouch for is not given
  // a scheme it can be pressed with.
  return <span class="login-link">{`${label} ${String(url ?? "")}`}</span>;
}

/** One notification of the flow, as its own row. */
function EventRow({ event }: { readonly event: LoginEvent }) {
  if (event.type === "auth_url") {
    return (
      <div class="login-event">
        <LoginLink url={event.url} label="Open the sign-in page" />
        {typeof event.instructions === "string" && event.instructions !== "" ? (
          <p class="login-hint">{event.instructions}</p>
        ) : null}
      </div>
    );
  }
  if (event.type === "device_code") {
    return (
      <div class="login-event">
        <p class="login-hint">Enter this code on the provider's page:</p>
        <code class="login-code">{event.userCode}</code>
        <LoginLink url={event.verificationUri} label={event.verificationUri} />
      </div>
    );
  }
  const links = event.type === "info" && Array.isArray(event.links) ? event.links : [];
  return (
    <div class="login-event">
      <p class="login-hint">{event.message}</p>
      {links.map((link, index) => (
        <LoginLink key={index} url={link.url} label={link.label ?? link.url} />
      ))}
    </div>
  );
}

/**
 * What a question is, as one string.
 *
 * It is the key the answer field is drawn with: the same question asked again
 * keys the same field, and a different question gets a new one. The provider's
 * message is the part that names the question; the placeholder and the type go
 * with it because they say how to answer it.
 */
function promptKey(prompt: LoginPrompt): string {
  return [prompt.type, prompt.message, prompt.placeholder ?? ""].join("\u0000");
}

/** The field or the choice list the flow is waiting on. */
function PromptView({ prompt }: { readonly prompt: LoginPrompt }) {
  if (prompt.type === "select") {
    return (
      <>
        <p class="login-hint">{prompt.message}</p>
        <div class="login-options">
          {(prompt.options ?? []).map((option) => (
            <button
              key={option.id}
              type="button"
              class="button"
              data-option={option.id}
              title={option.description ?? ""}
              onClick={() => void submitLoginAnswer(option.id)}
            >
              {option.label}
            </button>
          ))}
        </div>
      </>
    );
  }
  // A secret answer is typed into a password field, which is the one place the
  // browser keeps it off the screen; everything else is a plain text field.
  const kind = prompt.type === "secret" ? ({ type: "password" } as const) : ({ type: "text" } as const);
  return (
    <>
      <p class="login-hint">{prompt.message}</p>
      <div class="login-answer-row">
        <input
          // The key is the question: a poll asking it again reuses this element,
          // so the key pasted into it, the caret and the focus stay put.
          key={promptKey(prompt)}
          id="login-answer"
          class="login-input"
          {...kind}
          autocomplete="off"
          spellcheck={false}
          placeholder={prompt.placeholder ?? ""}
          aria-label={prompt.message}
          ref={(element: HTMLInputElement | null) => {
            // A question that has just appeared is the one thing to answer; an
            // element that is already there keeps whatever the reader is doing.
            if (element !== null && openPane.value === "login") element.focus();
          }}
        />
        <button
          id="login-answer-submit"
          class="button button-primary"
          type="button"
          onClick={(event) => {
            const row = event.currentTarget.parentElement;
            const field = row?.querySelector<HTMLInputElement>("#login-answer") ?? null;
            if (field === null) return;
            const value = field.value;
            // Cleared before it is sent: the field is the only place the page holds it.
            field.value = "";
            void submitLoginAnswer(value);
          }}
        >
          Submit
        </button>
      </div>
    </>
  );
}

export function LoginPanel() {
  const state = loginState.value;
  const live = loginIsLive();
  const usable = usableProviders();
  const types = selectedTypes();
  const prompt = state !== null && state.status === "prompt" ? state.prompt : null;
  const events = state?.events ?? [];
  const status = loginStatusLine();
  return (
    <aside id="login-pane" class="login-pane" aria-label="Model login">
      <div class="login-pane-head">
        <h2 class="login-pane-title">Model login</h2>
        <button
          id="login-pane-close"
          class="button"
          type="button"
          aria-label="Close the login panel"
          onClick={() => closeLoginPanel()}
        >
          ✕
        </button>
      </div>
      <p id="login-intro" class="login-hint">
        {loginIntro()}
      </p>
      <label class="login-field">
        <span class="login-label">Provider</span>
        <select
          id="login-provider"
          class="login-select"
          disabled={usable.length === 0 || live}
          value={chosenProvider.value}
          onChange={(event) => {
            chosenProvider.value = event.currentTarget.value;
          }}
        >
          {usable.map((entry) => (
            <option key={entry.id} value={entry.id}>
              {entry.configured === true ? entry.id : `${entry.id} (no credential)`}
              {entry.extension === null || entry.extension === undefined ? "" : ` [${entry.extension}]`}
            </option>
          ))}
        </select>
      </label>
      <label class="login-field">
        <span class="login-label">Login type</span>
        <select
          id="login-type"
          class="login-select"
          disabled={types.length === 0 || live}
          value={chosenType.value}
          onChange={(event) => {
            chosenType.value = event.currentTarget.value;
          }}
        >
          {types.map((type) => (
            <option key={type} value={type}>
              {loginTypeLabel(type)}
            </option>
          ))}
        </select>
      </label>
      <p id="login-provider-note" class="login-hint">
        {loginProviderNote()}
      </p>
      <div class="login-actions">
        <button
          id="login-start"
          class={live ? "button button-primary hidden" : "button button-primary"}
          type="button"
          disabled={!loginAvailable.value}
          onClick={() => void startLogin()}
        >
          Start login
        </button>
        <button
          id="login-cancel"
          class={live ? "button button-danger" : "button button-danger hidden"}
          type="button"
          onClick={() => void cancelLogin()}
        >
          Cancel
        </button>
      </div>
      <div id="login-events" class="login-events">
        {events.map((event, index) => (
          <EventRow key={index} event={event} />
        ))}
      </div>
      <div id="login-prompt" class="login-prompt">
        {prompt === null ? null : <PromptView prompt={prompt} />}
        {typeof state?.warning === "string" && state.warning !== "" ? (
          <p class="login-warning">{state.warning}</p>
        ) : null}
      </div>
      <p id="login-status" class="login-status" role="status">
        {status}
      </p>
      <p id="login-error" class="login-error" role="status">
        {loginError.value}
      </p>
    </aside>
  );
}
