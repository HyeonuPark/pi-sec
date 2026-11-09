/**
 * The one message a press on Send holds while the agent is busy.
 *
 * A press on Send while a run is active on a connected page queues the text, and
 * the page sends it by itself the moment it can send again. The queue is one
 * flag and the tray as it was at queue time. It lives in the page memory only: a
 * reload or a move to another conversation drops it. `Enter` never queues.
 *
 * The queue ends without a send when the field gets an input event, when the
 * tray changes, or when the page is left. A failed automatic send leaves the
 * text in the field and the queue gone.
 */
import { effect, signal } from "@preact/signals";
import { attachmentIsUploading, attachments, readyAttachmentIds, type AttachmentEntry } from "./attachments.ts";
import { composerText, submitComposer } from "./composer.ts";
import { agentBusy, canSend } from "./run.ts";
import { showToast } from "./toast.ts";

/** True while a message is queued. */
export const sendQueued = signal(false);

/** The tray as it was when the queue began. A different array means the tray changed. */
let queuedTray: readonly AttachmentEntry[] | null = null;

/** Queue the message, if the agent is busy and there is something to send. */
export function queueSend(): void {
  if (!agentBusy.value) return;
  if (sendQueued.value) return;
  if (composerText.value.trim() === "" && readyAttachmentIds().length === 0) return;
  if (attachmentIsUploading()) {
    showToast("A file is still uploading. Send again when its chip stops moving.", { kind: "info" });
    return;
  }
  queuedTray = attachments.value;
  sendQueued.value = true;
}

/** End the queue without a send. */
export function cancelQueuedSend(): void {
  queuedTray = null;
  sendQueued.value = false;
}

/** Send the queued message when the page can send, and drop it when the tray changed. Returns the stop function. */
export function watchSendQueue(): () => void {
  return effect(() => {
    if (!sendQueued.value) return;
    if (attachments.value !== queuedTray) {
      cancelQueuedSend();
      return;
    }
    if (!canSend.value) return;
    cancelQueuedSend();
    void submitComposer();
  });
}
