/**
 * The setup card: three steps in the chat area while the daemon has no model.
 *
 * Step 1 opens the model login panel. Step 2 is the model form, and its Save
 * writes the choice and loads the configuration in one request. Step 3 reads
 * config.json again, for the operator who ran `pi-sec setup-model` on the server.
 * The card is hidden whenever the daemon has a model.
 */
import { useEffect } from "preact/hooks";
import { modelSetupRequired } from "../../state/run.ts";
import {
  SETUP_COMMAND,
  THINKING_LEVELS,
  copySetupCommand,
  pressSetupLogin,
  reloadSetup,
  saveSetup,
  setupCanSave,
  setupCopyNote,
  setupError,
  setupExisting,
  setupForce,
  setupIssues,
  setupLoaded,
  setupModel,
  setupProviders,
  setupReloading,
  setupSaving,
  setupThinking,
  setupWorker,
  setupWorkerOpen,
  modelKey,
  startSetup,
} from "../../state/setup.ts";
import type { SetupModelProvider, SetupThinkingLevel } from "../../../shared/wire/model-setup.ts";

/** What the replace box says: which entries change, and who else follows. */
export const FORCE_LABEL =
  "Replace existing vmodels: root, orchestrator, planner and worker are set to the new model, and a scheduled job that names one of them also runs on it.";

/** One model list, grouped by provider. */
function ModelSelect(props: {
  readonly id: string;
  readonly label: string;
  readonly providers: readonly SetupModelProvider[];
  readonly value: string;
  readonly onChange: (value: string) => void;
}) {
  return (
    <label class="setup-field">
      <span>{props.label}</span>
      <select
        id={props.id}
        class="login-select"
        value={props.value}
        onChange={(event) => props.onChange((event.currentTarget as HTMLSelectElement).value)}
      >
        <option value="">Choose a model…</option>
        {props.providers.map((provider) => (
          <optgroup key={provider.id} label={provider.id}>
            {provider.models.map((choice) => (
              <option key={choice.id} value={modelKey(provider.id, choice.id)}>
                {choice.name === "" || choice.name === choice.id ? choice.id : `${choice.name} (${choice.id})`}
              </option>
            ))}
          </optgroup>
        ))}
      </select>
    </label>
  );
}

/** Step 2: the model form, or the sentence that sends the operator back to step 1. */
function ModelForm() {
  const providers = setupProviders.value;
  if (!setupLoaded.value) return <p class="login-hint">Reading the model list…</p>;
  if (providers.length === 0) {
    return (
      <p id="setup-no-provider" class="login-hint">
        No provider is signed in. Finish step 1 first, then choose a model here.
      </p>
    );
  }
  return (
    <form
      id="setup-form"
      class="setup-form"
      onSubmit={(event) => {
        event.preventDefault();
        void saveSetup();
      }}
    >
      <ModelSelect
        id="setup-model"
        label="Model"
        providers={providers}
        value={setupModel.value}
        onChange={(value) => (setupModel.value = value)}
      />
      <label class="setup-field">
        <span>Thinking level</span>
        <select
          id="setup-thinking"
          class="login-select"
          value={setupThinking.value}
          onChange={(event) => (setupThinking.value = (event.currentTarget as HTMLSelectElement).value as SetupThinkingLevel)}
        >
          {THINKING_LEVELS.map((level) => (
            <option key={level} value={level}>
              {level}
            </option>
          ))}
        </select>
      </label>
      <details
        id="setup-worker-section"
        class="setup-worker"
        open={setupWorkerOpen.value}
        onToggle={(event) => (setupWorkerOpen.value = (event.currentTarget as HTMLDetailsElement).open)}
      >
        <summary>Workers on another model</summary>
        <ModelSelect
          id="setup-worker"
          label="Worker model"
          providers={providers}
          value={setupWorker.value}
          onChange={(value) => (setupWorker.value = value)}
        />
      </details>
      {setupExisting.value.length > 0 ? (
        <label class="setup-check">
          <input
            id="setup-force"
            type="checkbox"
            checked={setupForce.value}
            onChange={(event) => (setupForce.value = (event.currentTarget as HTMLInputElement).checked)}
          />
          <span>{FORCE_LABEL}</span>
        </label>
      ) : null}
      <div class="setup-actions">
        <button id="setup-save" class="button button-primary" type="submit" disabled={!setupCanSave()}>
          {setupSaving.value ? "Saving…" : "Save"}
        </button>
      </div>
      <p id="setup-error" class="login-error" role="status">
        {setupError.value}
      </p>
      <p class="login-hint setup-command">
        Or on the server: <code>{SETUP_COMMAND}</code>{" "}
        <button id="setup-copy" class="button" type="button" onClick={() => void copySetupCommand()}>
          Copy
        </button>{" "}
        <span id="setup-copy-note">{setupCopyNote.value}</span>
      </p>
    </form>
  );
}

/** The card. It draws nothing visible unless the daemon waits for a first model. */
export function SetupCard() {
  const needed = modelSetupRequired.value;
  useEffect(() => {
    if (needed) startSetup();
  }, [needed]);
  const issues = setupIssues.value;
  return (
    <section id="setup-card" class={`setup-card${needed ? "" : " hidden"}`} aria-label="Model setup">
      {needed ? (
        <>
          <h2 class="setup-title">Choose the first model</h2>
          <p class="login-hint">This daemon has no model yet. Three steps set one.</p>
          <div class="setup-step">
            <h3>1. Sign a provider in</h3>
            <button id="setup-login" class="button" type="button" onClick={() => pressSetupLogin()}>
              Open model login
            </button>
          </div>
          <div class="setup-step">
            <h3>2. Choose the model</h3>
            <ModelForm />
          </div>
          <div class="setup-step">
            <h3>3. Load the configuration</h3>
            <p class="login-hint">
              If you ran <code>pi-sec setup-model</code> on the server, read config.json again here.
            </p>
            <button id="setup-reload" class="button" type="button" disabled={setupReloading.value} onClick={() => void reloadSetup()}>
              {setupReloading.value ? "Loading…" : "Load configuration"}
            </button>
            <div id="setup-issues" class="login-error" role="status">
              {issues.map((issue) => (
                <p key={issue}>{issue}</p>
              ))}
            </div>
          </div>
        </>
      ) : null}
    </section>
  );
}
