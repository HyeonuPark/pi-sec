/**
 * The connection pill, the activity ring and the model pill: the three things the
 * header says while the conversation streams.
 *
 * Each is mounted in place of the element the shell already carries, so the CSS
 * that styles `.pill` and `.spinner` applies without a change.
 */
import { activityStage, connected, model, modelSetupRequired } from "../../state/run.ts";

/** `live` or `offline`, in the colour the shell's CSS gives the two states. */
export function ConnectionPill() {
  const online = connected.value;
  // No model means no chat stream to reach: the page is waiting for setup, not offline.
  if (modelSetupRequired.value) {
    return (
      <span id="connection" class="pill pill-muted" role="status">
        setup
      </span>
    );
  }
  return (
    <span id="connection" class={`pill ${online ? "pill-online" : "pill-offline"}`} role="status">
      {online ? "live" : "offline"}
    </span>
  );
}

/**
 * The ring that turns while the agent works: blue while the model is waited on or
 * answering, green while a tool runs, red while the page cannot reach the server.
 *
 * Hidden at rest, so it costs no room, and `aria-hidden` because it only repeats
 * what the transcript shows. Its stage is `data-stage`, which is what the CSS reads.
 */
export function ActivityRing() {
  const stage = activityStage.value;
  const hidden = stage === "";
  return (
    <span
      id="activity"
      class={`spinner${hidden ? " hidden" : ""}`}
      aria-hidden="true"
      data-stage={hidden ? undefined : stage}
    />
  );
}

/** `provider/modelId` of the shown conversation, or `—` before the first snapshot. */
export function ModelPill() {
  const current = model.value;
  return (
    <span id="model" class="pill pill-muted">
      {current ? `${current.provider}/${current.modelId}` : "—"}
    </span>
  );
}
