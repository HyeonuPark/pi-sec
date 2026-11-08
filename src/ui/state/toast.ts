/**
 * The one notice a page shows, and how long it stays.
 *
 * Every page had its own copy of this: the chat page's `showToast`, the report
 * viewer's `showError`, the chats list's `showError`, and the usage page's
 * `showError` on `#usage-toast`. They agreed on the element (`.toast`, hidden by
 * a class), on one notice at a time, and on a timed hide, and they differed on
 * the colour and the wait. This module keeps the shared part and puts the
 * differences where a caller can name them:
 *
 * - An error (the default) stays 8 s. It is the red one.
 * - An info message stays 15 s and carries `toast-info`, the accent colour. It
 *   is something the operator asked for and is on its way.
 * - A caller can name another wait, which is what the usage page's 6 s needs.
 *
 * A second notice replaces the text and starts the wait again; the old timer is
 * cleared first, so the new notice gets its whole time. A notice that is hidden
 * keeps its text, as the element always did: hiding is a class, not a rewrite.
 *
 * The timer lives here and not in the component, because timers belong to the
 * state modules (`test/ui/state-and-sources.test.ts`).
 */
import { signal } from "@preact/signals";

/** How the notice looks: a failure, or something that went as asked. */
export type ToastKind = "error" | "info";

/** What the one notice holds. */
export interface ToastState {
  /** The text last shown. It outlives the hide, as the element's text did. */
  readonly text: string;
  readonly kind: ToastKind;
  /** False once the wait is over, or after {@link hideToast}. */
  readonly visible: boolean;
}

/** The wait of an error notice, in milliseconds. */
export const TOAST_ERROR_MS = 8000;

/** The wait of an info notice, in milliseconds. */
export const TOAST_INFO_MS = 15000;

/** The notice the page's `Toast` component draws. */
export const toast = signal<ToastState>({ text: "", kind: "error", visible: false });

/** What a caller may pass beside the text. */
export interface ToastOptions {
  /** `error` (the default) is red; `info` is the accent colour and stays longer. */
  readonly kind?: ToastKind;
  /** The wait in milliseconds. Defaults to the kind's own wait. */
  readonly durationMs?: number;
}

/** The running hide timer, or `undefined` when no notice is waiting to hide. */
let timer: ReturnType<typeof setTimeout> | undefined;

/** Stop the wait. */
function clearTimer(): void {
  if (timer === undefined) return;
  clearTimeout(timer);
  timer = undefined;
}

/** Hide the notice now. Its text stays, as the element's always did. */
export function hideToast(): void {
  clearTimer();
  const current = toast.value;
  if (!current.visible) return;
  toast.value = { ...current, visible: false };
}

/**
 * Show one notice: the text, the colour, and the wait.
 *
 * A notice already on screen is replaced, and its remaining wait is dropped: the
 * reader gets the whole wait to read the new text.
 */
export function showToast(text: string, options: ToastOptions = {}): void {
  const kind = options.kind ?? "error";
  const durationMs = options.durationMs ?? (kind === "info" ? TOAST_INFO_MS : TOAST_ERROR_MS);
  toast.value = { text: String(text ?? ""), kind, visible: true };
  clearTimer();
  timer = setTimeout(() => {
    timer = undefined;
    toast.value = { ...toast.value, visible: false };
  }, durationMs);
}

/** The failure spelling the pages used: an error notice, 8 s. */
export function showError(message: string): void {
  showToast(message, { kind: "error" });
}
