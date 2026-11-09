/**
 * The row under the field: Stop, the `⋯` menu, and Send.
 *
 * Three actions at every width. What used to crowd this row lives in the menu:
 * a new session, a compaction, the model login, the UI restart and the two
 * server restarts. Stop is inert unless a run is active. Send is inert while the
 * page is offline, has no model or has a send on its way. While a run is active
 * on a connected page it takes a press and queues the message (`send-queue.ts`);
 * `Enter` does not queue.
 *
 * The menu is the operator's: a press on `⋯` opens it, choosing from it closes
 * it, and so do `Esc` and a press anywhere else (the page's own listeners, in
 * `../ComposerParts.tsx`). Nothing the server sends opens or closes it.
 */
import { askNewSession, compactContext, composerMenuOpen, toggleComposerMenu, setComposerMenu, abortRun, openLoginPane, restartServer, restartUi } from "../../state/composer.ts";
import { queueSend } from "../../state/send-queue.ts";
import { agentBusy, canSend, running } from "../../state/run.ts";

/** Title of the Send button while the agent is busy. */
export const BUSY_SEND_TITLE = "The agent is busy. Press to send when it is idle.";

/** One entry of the `⋯` menu. */
interface MenuEntry {
  readonly id: string;
  readonly label: string;
  /** What a press does. The menu closes first, whatever it is. */
  run(): void;
}

const ENTRIES: readonly MenuEntry[] = [
  { id: "reset", label: "New session", run: () => askNewSession() },
  { id: "compact", label: "Compact", run: () => compactContext() },
  // Signs a model provider in, and belongs with the actions that change the
  // server rather than with the ones that change this conversation.
  { id: "model-login", label: "Model login", run: () => openLoginPane() },
  { id: "restart-ui", label: "Restart UI", run: () => void restartUi() },
  { id: "restart", label: "Restart server", run: () => void restartServer() },
  { id: "restart-reinstall", label: "Force reinstall and restart", run: () => void restartServer({ reinstall: true }) },
];

/** Stop, the menu and Send. */
export function ComposerActions() {
  const open = composerMenuOpen.value;
  const takeable = canSend.value;
  const busy = agentBusy.value;
  return (
    <div class="composer-actions">
      <button id="abort" type="button" class="button button-danger" disabled={!running.value} onClick={() => abortRun()}>
        Stop
      </button>
      <div class="composer-more">
        <button
          id="more-actions"
          class="button"
          type="button"
          aria-expanded={open ? "true" : "false"}
          aria-controls="composer-menu"
          aria-haspopup="menu"
          aria-label="More actions"
          onClick={() => toggleComposerMenu()}
        >
          ⋯
        </button>
        <div id="composer-menu" class={`composer-menu${open ? " open" : ""}`} role="menu" aria-label="More actions">
          {ENTRIES.map((entry) => (
            <button
              key={entry.id}
              id={entry.id}
              type="button"
              class="button"
              role="menuitem"
              onClick={() => {
                setComposerMenu(false);
                entry.run();
              }}
            >
              {entry.label}
            </button>
          ))}
        </div>
      </div>
      <button
        id="send"
        type="submit"
        class={`button button-primary${busy ? " send-busy" : ""}`}
        disabled={!takeable && !busy}
        title={busy ? BUSY_SEND_TITLE : undefined}
        onClick={(event) => {
          // Decided from the signal at the moment of the press, not from the drawn
          // attribute: a second click can arrive before the page redraws.
          if (!agentBusy.value) return;
          event.preventDefault();
          queueSend();
        }}
      >
        Send
      </button>
    </div>
  );
}
