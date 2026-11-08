/**
 * The one notice a page shows.
 *
 * The element, its classes and its accessibility wiring are the ones the shells
 * carry today: `#toast` (or `#usage-toast` on the usage page), `class="toast
 * hidden"`, `role="alert"` and `aria-live="assertive"`. A page that draws this
 * component draws that element; the old copies in the shells go away with them.
 *
 * What it shows, how long, and what a second notice does live in
 * `src/ui/state/toast.ts`, because the timer belongs to a state module. This file
 * only reads the state and draws it, so a notice and the code that raised it
 * cannot disagree about the class or the attribute.
 */
import { toast } from "../state/toast.ts";

export interface ToastProps {
  /** The element's id. `toast` unless the page names another (`usage-toast`). */
  readonly id?: string;
}

/** The notice element. It is drawn at rest too, hidden, as the shells draw it. */
export function Toast({ id = "toast" }: ToastProps) {
  const state = toast.value;
  const className = state.kind === "info" ? "toast toast-info" : "toast";
  return (
    <div
      id={id}
      class={state.visible ? className : `${className} hidden`}
      role="alert"
      aria-live="assertive"
    >
      {state.text}
    </div>
  );
}
